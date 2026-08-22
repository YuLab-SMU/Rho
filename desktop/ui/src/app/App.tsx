import { useEffect, useMemo, useState } from "react";

import { createBootstrapTransport } from "../transport";
import type { BootstrapSnapshot, BootstrapTransport } from "../transport";

interface AppProps {
  readonly transport?: BootstrapTransport;
}

const defaultBootstrapTransport = createBootstrapTransport();

type BootstrapState =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly snapshot: BootstrapSnapshot }
  | { readonly kind: "failed"; readonly message: string };

function displayError(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message.slice(0, 512);
  return "Rho could not load the startup snapshot.";
}

export function App({ transport }: AppProps) {
  const resolvedTransport = transport ?? defaultBootstrapTransport;
  const [state, setState] = useState<BootstrapState>({ kind: "loading" });

  useEffect(() => {
    let current = true;
    void resolvedTransport.loadBootstrap().then(
      (snapshot) => {
        if (current) setState({ kind: "ready", snapshot });
      },
      (error: unknown) => {
        if (current) setState({ kind: "failed", message: displayError(error) });
      },
    );
    return () => {
      current = false;
    };
  }, [resolvedTransport]);

  const evidence = useMemo(() => {
    if (state.kind === "loading") return { ready: false, state: "loading" };
    if (state.kind === "failed") return { ready: false, state: "failed" };
    return {
      ready: true,
      state: state.snapshot.startup.state,
      project: state.snapshot.project.root,
      source: state.snapshot.source,
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
          <strong>{state.kind === "ready" ? state.snapshot.project.label : "Loading…"}</strong>
        </div>
        <div className="rho-foundation-status" aria-live="polite">
          <span
            className={`rho-status-dot rho-status-${
              state.kind === "ready" ? state.snapshot.startup.state : state.kind
            }`}
            aria-hidden="true"
          />
          <span>
            {state.kind === "ready"
              ? state.snapshot.startup.title
              : state.kind === "failed"
                ? "Startup snapshot unavailable"
                : "Connecting to local Rho"}
          </span>
        </div>
      </header>

      <section className="rho-foundation-stage" aria-labelledby="foundation-title">
        <div className="rho-foundation-orbit" aria-hidden="true" />
        <div className="rho-foundation-copy">
          <span className="rho-eyebrow">New frontend workspace</span>
          <h1 id="foundation-title">Rho Surface Runtime</h1>
          {state.kind === "loading" && <p>Reading project and startup health…</p>}
          {state.kind === "failed" && <p role="alert">{state.message}</p>}
          {state.kind === "ready" && (
            <>
              <p>
                The new composition kernel has a clean renderer boundary. Surfaces arrive in
                the next integration wave.
              </p>
              <dl className="rho-bootstrap-facts">
                <div>
                  <dt>Project root</dt>
                  <dd title={state.snapshot.project.root}>{state.snapshot.project.root}</dd>
                </div>
                <div>
                  <dt>Startup phase</dt>
                  <dd>{state.snapshot.startup.phase}</dd>
                </div>
              </dl>
              {state.snapshot.startup.detail != null && (
                <p className="rho-foundation-notice">{state.snapshot.startup.detail}</p>
              )}
            </>
          )}
        </div>
      </section>
      <pre id="rsrPreviewEvidence" hidden>{JSON.stringify(evidence)}</pre>
    </main>
  );
}
