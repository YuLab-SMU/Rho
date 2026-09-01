import { useCallback, useEffect, useState } from "react";

import type {
  DomainSurfaceData,
  SurfaceInstance,
  UiKernelTransport,
} from "../transport";
import {
  domainEmptyState,
  domainItemPresentation,
  domainItemsForMode,
  domainMatches,
  domainPresentationKind,
  domainSummary,
} from "./domain-presentation";
import { SurfaceTaskState } from "./SurfaceTaskState";
import { workbenchFailureMessage } from "./workbench-failure";

export const DOMAIN_SURFACE_IDS = new Set([
  "rho.git",
  "rho.logs", "rho.help",
]);
interface DomainSurfaceViewProps {
  readonly instance: SurfaceInstance;
  readonly transport: UiKernelTransport;
  readonly persist: (viewState: unknown) => Promise<void>;
  readonly reportError: (error: unknown) => void;
  readonly openSurfaceById: (surfaceId: string) => void;
}

function viewStateRecord(viewState: unknown): Readonly<Record<string, unknown>> {
  return typeof viewState === "object" && viewState != null && !Array.isArray(viewState)
    ? viewState as Readonly<Record<string, unknown>>
    : {};
}

function viewStateFilter(viewState: unknown): string {
  const record = viewStateRecord(viewState);
  return typeof record.filter === "string" ? record.filter : "";
}

function viewStateWithFilter(viewState: unknown, filter: string): Readonly<Record<string, unknown>> {
  return { ...viewStateRecord(viewState), filter };
}

export function DomainSurfaceView(props: DomainSurfaceViewProps) {
  return <GenericDomainSurfaceView
    key={`${props.instance.project_id}:${props.instance.surface_id}`}
    {...props}
  />;
}

function GenericDomainSurfaceView({
  instance,
  transport,
  persist,
  reportError,
}: DomainSurfaceViewProps) {
  const initialFilter = viewStateFilter(instance.view_state);
  const [filter, setFilter] = useState(initialFilter);
  const [searchOpen, setSearchOpen] = useState(Boolean(initialFilter) ||
    (instance.surface_id === "rho.help" && instance.mode_id === "search"));
  const [data, setData] = useState<DomainSurfaceData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await transport.loadDomainSurface(instance.surface_id));
      setError(null);
    } catch (cause: unknown) {
      setError(workbenchFailureMessage(cause, "This component could not load."));
    } finally {
      setLoading(false);
    }
  }, [instance.surface_id, transport]);
  useEffect(() => {
    void load();
    return transport.subscribeInvalidated(() => void load());
  }, [load, transport]);
  const modeItems = domainItemsForMode(instance.surface_id, instance.mode_id, data?.items ?? []);
  const items = modeItems.filter((item) => domainMatches(instance.surface_id, item, filter));
  const summary = domainSummary(instance.surface_id, modeItems);
  const kind = domainPresentationKind(instance.surface_id);
  const strip = instance.surface_id === "rho.logs";
  const closeSearch = () => {
    setFilter("");
    setSearchOpen(false);
    void persist(viewStateWithFilter(instance.view_state, "")).catch(reportError);
  };
  return (
    <section className={`rho-domain-surface rho-domain-kind-${kind} ${strip ? "rho-domain-strip" : ""}`} data-domain-kind={kind}>
      <header className="rho-domain-toolbar">
        <div>
          <strong>{loading && data == null ? "Loading…" : summary.title}</strong>
          <small>{loading && data == null ? "Reading project state" : summary.subtitle}</small>
        </div>
        {!strip && <button
          type="button"
          className="rho-icon-btn"
          aria-label={searchOpen ? `Close ${instance.surface_id} search` : `Search ${instance.surface_id}`}
          aria-expanded={searchOpen}
          onClick={() => searchOpen ? closeSearch() : setSearchOpen(true)}
        >
          {searchOpen ? "×" : <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
            <circle cx="7" cy="7" r="4" fill="none" stroke="currentColor" strokeWidth="1.5" />
            <path d="m10 10 3.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>}
        </button>}
        <button type="button" className="rho-icon-btn" aria-label={`Refresh ${instance.surface_id}`} disabled={loading} onClick={() => void load()}>
          <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
            <path d="M13 5V2.5L11.4 4A5 5 0 1 0 13 9" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </header>
      {searchOpen && !strip && <div className="rho-domain-search">
        <input
          autoFocus
          type="search"
          aria-label={`Filter ${instance.surface_id}`}
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          onBlur={() => void persist(viewStateWithFilter(instance.view_state, filter)).catch(reportError)}
          onKeyDown={(event) => { if (event.key === "Escape") closeSearch(); }}
          placeholder={kind === "help" ? "Find a command or topic…" : "Search this view…"}
        />
      </div>}
      {error != null && <SurfaceTaskState tone="error" title="This view is unavailable" detail={error} role="alert" className="rho-domain-error">
        <button type="button" onClick={() => void load()}>Try again</button>
      </SurfaceTaskState>}
      {error == null && <div className="rho-domain-records" aria-busy={loading}>
        {loading && data == null && <SurfaceTaskState tone="loading" title="Loading this view…" detail="Reading the current project records." role="status" busy />}
        {!loading && items.length === 0 && (() => {
          const empty = domainEmptyState(instance.surface_id, Boolean(filter.trim()));
          return <SurfaceTaskState tone="empty" title={empty.title} detail={empty.detail} role="status" className="rho-domain-empty" />;
        })()}
        {items.map((item) => {
          const projected = domainItemPresentation(instance.surface_id, item);
          return <article className={`rho-domain-record rho-domain-record-${projected.tone}`} data-domain-id={item.id} key={item.id}>
            <span className={`rho-domain-indicator rho-domain-indicator-${projected.tone}`} aria-hidden="true" />
            <div className="rho-domain-record-copy">
              <strong title={projected.title}>{projected.title}</strong>
              {projected.code != null && <pre className="rho-domain-code"><code>{projected.code}</code></pre>}
              {projected.description != null && <p>{projected.description}</p>}
              {projected.meta.length > 0 && <ul aria-label={`Facts for ${projected.title}`}>{projected.meta.map((fact) => <li key={fact}>{fact}</li>)}</ul>}
            </div>
            <span className={`rho-domain-state rho-domain-${projected.status}`}>{projected.status}</span>
            {projected.disclosureLabel != null && projected.disclosureText != null && <details className="rho-domain-disclosure">
              <summary>{projected.disclosureLabel}</summary><pre>{projected.disclosureText}</pre>
            </details>}
          </article>;
        })}
      </div>}
    </section>
  );
}
