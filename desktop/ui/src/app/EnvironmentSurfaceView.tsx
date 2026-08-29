import { useCallback, useEffect, useState } from "react";

import type { DomainSurfaceData, SurfaceInstance, UiKernelTransport } from "../transport";
import type { ToolchainDoctorView } from "../transport/environment";
import {
  environmentDetail,
  environmentItemsForMode,
  environmentMatches,
  environmentSummary,
  environmentTone,
} from "./environment-presentation";
import type { EnvironmentMode } from "./environment-presentation";
import { SurfaceTaskState } from "./SurfaceTaskState";
import { workbenchFailureMessage } from "./workbench-failure";

function ToolchainDoctorPanel({
  view,
  loading,
  error,
  reload,
}: {
  readonly view: ToolchainDoctorView | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly reload: () => void;
}) {
  return <section className="rho-toolchain-surface" aria-label="Project toolchains">
    <header className="rho-environment-toolbar">
      <div>
        <strong>Toolchains</strong>
        <small>{view == null ? "Checking rho.toml, rig, renv, pak, and uv" : view.status === "ready"
          ? "Exact project environments are ready"
          : view.status === "unmanaged" ? "No managed project environment" : "Environment admission is blocked"}</small>
      </div>
      <button type="button" className="rho-icon-btn" aria-label="Refresh toolchains" disabled={loading} onClick={reload}>↻</button>
    </header>
    {loading && view == null && <SurfaceTaskState tone="loading" title="Checking toolchains…" detail="Resolving exact project runtimes without changing environments or lockfiles." role="status" busy />}
    {error != null && <SurfaceTaskState tone="error" title="Toolchain Doctor unavailable" detail={error} role="alert"><button type="button" onClick={reload}>Try again</button></SurfaceTaskState>}
    {error == null && view != null && <div className="rho-toolchain-body">
      <div className={`rho-toolchain-summary rho-toolchain-summary-${view.status}`}>
        <span className={`rho-domain-state rho-domain-${view.status === "ready" ? "ready" : view.status === "failed" ? "error" : "warning"}`}>{view.status}</span>
        <div><strong>{view.configured ? "rho.toml managed" : "Unmanaged project"}</strong>
          <small>{view.rho_toml_sha256 == null ? "No configuration digest" : `Config ${view.rho_toml_sha256.slice(0, 12)}`}</small></div>
      </div>
      <div className="rho-toolchain-runtime-grid">
        <article>
          <span className="rho-eyebrow">R</span>
          <strong>{view.r_version == null ? "Not configured" : `R ${view.r_version}`}</strong>
          {view.rscript != null && <code>{view.rscript}</code>}
        </article>
        <article>
          <span className="rho-eyebrow">Python</span>
          <strong>{view.python_version == null ? "Not configured" : `Python ${view.python_version}`}</strong>
          {view.python != null && <code>{view.python}</code>}
        </article>
      </div>
      <ol className="rho-toolchain-checks">
        {view.checks.map((check) => <li data-status={check.status} key={check.id}>
          <span className={`rho-status-dot rho-status-${check.status === "ready" ? "ready" : "degraded"}`} aria-hidden="true" />
          <div><strong>{check.id}</strong><small>{check.detail}</small></div>
        </li>)}
      </ol>
    </div>}
  </section>;
}

export function EnvironmentSurfaceView({
  instance,
  transport,
  persist,
  reportError,
}: {
  readonly instance: SurfaceInstance;
  readonly transport: UiKernelTransport;
  readonly persist: (viewState: unknown) => Promise<void>;
  readonly reportError: (error: unknown) => void;
}) {
  const initialFilter = typeof instance.view_state === "object" && instance.view_state != null &&
      "filter" in instance.view_state && typeof instance.view_state.filter === "string"
    ? instance.view_state.filter
    : "";
  const toolchainMode = instance.mode_id === "toolchains";
  const mode: EnvironmentMode = instance.mode_id === "requests" ? "requests" : "packages";
  const [filter, setFilter] = useState(initialFilter);
  const [searchOpen, setSearchOpen] = useState(Boolean(initialFilter));
  const [data, setData] = useState<DomainSurfaceData | null>(null);
  const [toolchain, setToolchain] = useState<ToolchainDoctorView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      if (toolchainMode) {
        setToolchain(await transport.toolchainDoctor());
        setData(null);
      } else {
        setData(await transport.loadDomainSurface(instance.surface_id));
        setToolchain(null);
      }
      setError(null);
    } catch (cause: unknown) {
      setError(workbenchFailureMessage(cause, "Environment could not load."));
    } finally {
      setLoading(false);
    }
  }, [instance.surface_id, toolchainMode, transport]);
  useEffect(() => {
    void load();
    return transport.subscribeInvalidated(() => void load());
  }, [load, transport]);
  if (toolchainMode) {
    return <ToolchainDoctorPanel
      view={toolchain}
      loading={loading}
      error={error}
      reload={load}
    />;
  }
  const modeItems = environmentItemsForMode(data?.items ?? [], mode);
  const items = modeItems.filter((item) => environmentMatches(item, filter));
  const summary = environmentSummary(modeItems, mode);
  const closeSearch = () => {
    setFilter("");
    setSearchOpen(false);
    void persist({ filter: "" }).catch(reportError);
  };
  return (
    <section className="rho-environment-surface" aria-label="Project environment">
      <header className="rho-environment-toolbar">
        <div>
          <strong>{loading && data == null ? "Loading environment…" : summary.title}</strong>
          <small>{loading && data == null ? "Reading project state" : summary.subtitle}</small>
        </div>
        <button
          type="button"
          className="rho-icon-btn"
          aria-label={searchOpen ? "Close environment search" : "Search environment"}
          aria-expanded={searchOpen}
          onClick={() => searchOpen ? closeSearch() : setSearchOpen(true)}
        >
          {searchOpen ? "×" : <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
            <circle cx="7" cy="7" r="4" fill="none" stroke="currentColor" strokeWidth="1.5" />
            <path d="m10 10 3.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>}
        </button>
        <button type="button" className="rho-icon-btn" aria-label="Refresh environment" disabled={loading} onClick={() => void load()}>
          <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
            <path d="M13 5V2.5L11.4 4A5 5 0 1 0 13 9" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </header>
      {searchOpen && <div className="rho-environment-search">
        <input
          autoFocus
          type="search"
          aria-label="Filter environment"
          placeholder={mode === "packages" ? "Find a package…" : "Find an operation…"}
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          onBlur={() => void persist({ filter }).catch(reportError)}
          onKeyDown={(event) => { if (event.key === "Escape") closeSearch(); }}
        />
      </div>}
      {error != null && <SurfaceTaskState tone="error" title="Environment unavailable" detail={error} role="alert" className="rho-environment-error">
        <button type="button" onClick={() => void load()}>Try again</button>
      </SurfaceTaskState>}
      {error == null && <div className="rho-environment-records" aria-busy={loading}>
        {loading && data == null && <SurfaceTaskState tone="loading" title="Loading environment…" detail="Reading the current project library and operation requests." role="status" busy />}
        {!loading && items.length === 0 && <SurfaceTaskState
          tone="empty"
          title={filter ? "No matching results" : mode === "packages" ? "No packages resolved yet" : "No environment operations yet"}
          detail={filter ? "Try a package name, version, or status." : mode === "packages" ? "Package state will appear after the project library is inspected." : "Restore and install requests will appear here when they exist."}
          role="status"
          className="rho-environment-empty"
        />}
        {items.map((item) => {
          const tone = environmentTone(item);
          const detail = environmentDetail(item);
          return <article className={`rho-environment-record rho-environment-${tone}`} data-environment-id={item.id} key={item.id}>
            <span className={`rho-environment-indicator rho-environment-indicator-${tone}`} aria-hidden="true" />
            <div><strong>{item.title}</strong>{item.subtitle != null && <small>{item.subtitle}</small>}</div>
            <span className={`rho-domain-state rho-domain-${item.status ?? "neutral"}`}>{item.status ?? "unknown"}</span>
            {detail != null && <p>{detail}</p>}
          </article>;
        })}
      </div>}
    </section>
  );
}
