import { useEffect, useMemo, useState, useSyncExternalStore } from "react";

import {
  SurfaceExternalStore,
  UiExternalStore,
  commandsForPlacement,
  createUiKernelTransport,
} from "../transport";
import type {
  SurfaceInstance,
  SurfaceInstanceRequest,
  UiKernelTransport,
} from "../transport";

interface AppProps {
  readonly transport?: UiKernelTransport;
}

const defaultTransport = createUiKernelTransport();
const defaultStore = new UiExternalStore(defaultTransport);
const defaultSurfaceStore = new SurfaceExternalStore(defaultTransport);

function instanceRequest(
  instance: SurfaceInstance,
  projectRevision: number,
): SurfaceInstanceRequest {
  return {
    project_id: instance.project_id,
    instance_id: instance.instance_id,
    activation_generation: instance.activation_generation,
    expected_project_revision: projectRevision,
    expected_surface_revision: instance.surface_revision,
  };
}

interface SyntheticSurfaceProps {
  readonly instance: SurfaceInstance;
  readonly close: () => void;
}

function SyntheticSurface({ instance, close }: SyntheticSurfaceProps) {
  const [draft, setDraft] = useState("");
  return (
    <article
      className={`rho-synthetic-surface rho-surface-${instance.lifecycle_state}`}
      data-instance-id={instance.instance_id}
    >
      <header>
        <div>
          <span className="rho-eyebrow">Application Surface</span>
          <strong>Surface Playground</strong>
        </div>
        <button type="button" onClick={close} aria-label={`Close ${instance.instance_id}`}>
          Close
        </button>
      </header>
      <p>
        Independent instance <code>{instance.instance_id.slice(-8)}</code>
      </p>
      <label>
        Local draft
        <input
          aria-label={`Local draft ${instance.instance_id}`}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Type without affecting a sibling…"
        />
      </label>
      <footer>
        <span>{instance.mode_id ?? "default"}</span>
        <span>rev {instance.surface_revision}</span>
        <span>{instance.lifecycle_state}</span>
      </footer>
    </article>
  );
}

export function App({ transport }: AppProps) {
  const [surfaceActionError, setSurfaceActionError] = useState<string | null>(null);
  const store = useMemo(
    () => (transport == null ? defaultStore : new UiExternalStore(transport)),
    [transport],
  );
  const surfaceStore = useMemo(
    () => (transport == null ? defaultSurfaceStore : new SurfaceExternalStore(transport)),
    [transport],
  );
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const surfaceState = useSyncExternalStore(
    surfaceStore.subscribe,
    surfaceStore.getSnapshot,
    surfaceStore.getSnapshot,
  );
  const snapshot = state.status === "ready" ? state.snapshot : null;
  const primaryCommands = useMemo(
    () => (snapshot == null ? [] : commandsForPlacement(snapshot, "primary_candidate")),
    [snapshot],
  );
  const commandCount = snapshot?.command_registry.registrations.length ?? 0;
  const surfaceSnapshot = surfaceState.status === "ready" ? surfaceState.snapshot : null;
  const playgroundFactory = surfaceSnapshot?.catalog.factories.find(
    (factory) => factory.definition.surface_id === "rho.surface-playground",
  );
  const playgroundInstances =
    surfaceSnapshot?.catalog.instances.filter(
      (instance) => instance.surface_id === "rho.surface-playground",
    ) ?? [];
  const runSurfaceAction = (operation: Promise<unknown>) => {
    setSurfaceActionError(null);
    void operation.catch((error: unknown) => {
      setSurfaceActionError(
        error instanceof Error && error.message.trim()
          ? error.message.slice(0, 512)
          : "Surface operation failed.",
      );
    });
  };
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
      surfaceSnapshotRevision: surfaceSnapshot?.snapshot_revision ?? null,
      surfaceInstances: playgroundInstances.map((instance) => instance.instance_id),
    };
  }, [playgroundInstances, state, surfaceSnapshot?.snapshot_revision]);

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
              <section className="rho-surface-lab" aria-label="Surface instance playground">
                <header>
                  <div>
                    <span className="rho-eyebrow">Instance runtime</span>
                    <strong>{playgroundInstances.length} independent views</strong>
                  </div>
                  {playgroundFactory != null && surfaceSnapshot != null && (
                    <button
                      className="rho-add-surface"
                      type="button"
                      onClick={() => {
                        runSurfaceAction(surfaceStore.open({
                          surface_id: playgroundFactory.definition.surface_id,
                          project_id: surfaceSnapshot.project_id,
                          mode_id: playgroundFactory.definition.modes[0]?.mode_id ?? null,
                          resource_binding: null,
                          runtime_binding: null,
                          view_group_id: null,
                          view_state: {},
                          instance_disposition: "new_instance",
                          placement_intent: "current",
                          expected_project_revision: surfaceSnapshot.project_revision,
                          expected_layout_revision: 0,
                        }));
                      }}
                    >
                      New view
                    </button>
                  )}
                </header>
                {surfaceState.status === "loading" && <p>Reading Surface instances…</p>}
                {surfaceState.status === "failed" && (
                  <p role="alert">{surfaceState.message}</p>
                )}
                {surfaceActionError != null && <p role="alert">{surfaceActionError}</p>}
                <div className="rho-surface-row">
                  {playgroundInstances.map((instance) => (
                    <SyntheticSurface
                      key={instance.instance_id}
                      instance={instance}
                      close={() => {
                        if (surfaceSnapshot == null) return;
                        runSurfaceAction(surfaceStore.close(
                          instanceRequest(instance, surfaceSnapshot.project_revision),
                        ));
                      }}
                    />
                  ))}
                </div>
              </section>
            </>
          )}
        </div>
      </section>
      <pre id="rsrPreviewEvidence" hidden>{JSON.stringify(evidence)}</pre>
    </main>
  );
}
