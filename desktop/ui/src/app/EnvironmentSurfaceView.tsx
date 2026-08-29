import { useCallback, useEffect, useRef, useState } from "react";

import type { DomainSurfaceData, SurfaceInstance, UiKernelTransport } from "../transport";
import type { ResourceMonitorView, ToolchainDoctorView } from "../transport/environment";
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
        <div><strong>{view.configured ? `Target ${view.target_id}` : "Unmanaged project"}</strong>
          <small>{view.configured
            ? `${view.host_kind} / ${view.isolation_kind} · Config ${view.rho_toml_sha256?.slice(0, 12) ?? "unavailable"}`
            : "No configuration digest"}</small></div>
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

function formatBytes(value: string | null): string | null {
  if (value == null) return null;
  try {
    const bytes = BigInt(value);
    const units = ["B", "KiB", "MiB", "GiB", "TiB"] as const;
    let scaled = Number(bytes);
    let unit = 0;
    while (scaled >= 1024 && unit < units.length - 1) {
      scaled /= 1024;
      unit += 1;
    }
    return `${scaled >= 10 || unit === 0 ? scaled.toFixed(0) : scaled.toFixed(1)} ${units[unit]}`;
  } catch {
    return null;
  }
}

function formatPercent(value: number | null): string {
  return value == null ? "Not observed" : `${(value / 100).toFixed(value % 100 === 0 ? 0 : 1)}%`;
}

function ResourceMonitorPanel({
  view,
  loading,
  error,
  reload,
}: {
  readonly view: ResourceMonitorView | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly reload: () => void;
}) {
  const blocked = view?.targets.filter((target) => !target.admission_allowed).length ?? 0;
  return <section className="rho-resource-monitor" aria-label="Compute resource monitor">
    <header className="rho-environment-toolbar">
      <div>
        <strong>Resource governance</strong>
        <small>{view == null
          ? "Observing devices and target environments"
          : `${view.total_targets} ${view.total_targets === 1 ? "target" : "targets"} · ${blocked} admission ${blocked === 1 ? "guard" : "guards"} active`}</small>
      </div>
      <button type="button" className="rho-icon-btn" aria-label="Refresh resources" disabled={loading} onClick={reload}>↻</button>
    </header>
    {loading && view == null && <SurfaceTaskState tone="loading" title="Inspecting resources…" detail="Sampling CPU, memory, project storage, GPU telemetry, devices, and target environments." role="status" busy />}
    {error != null && <SurfaceTaskState tone="error" title="Resource monitor unavailable" detail={error} role="alert"><button type="button" onClick={reload}>Try again</button></SurfaceTaskState>}
    {error == null && view != null && <div className="rho-resource-monitor-body" aria-busy={loading}>
      <div className={`rho-resource-governance-summary rho-resource-pressure-${view.status}`}>
        <div><span className="rho-eyebrow">Fleet status</span><strong>{view.status}</strong></div>
        <small>CPU warn {(view.thresholds.cpu_warning_basis_points / 100).toFixed(0)}% · Memory guard below {(view.thresholds.memory_available_critical_basis_points / 100).toFixed(0)}% free · Disk guard below {(view.thresholds.disk_available_critical_basis_points / 100).toFixed(0)}% free</small>
      </div>
      {view.truncated && <p className="rho-resource-monitor-notice">Showing the first monitored targets; the registry contains {view.total_targets} entries.</p>}
      <div className="rho-resource-targets">
        {view.targets.map((target) => <article className={`rho-resource-target rho-resource-pressure-${target.status}`} data-target-id={target.target_id} key={target.target_id}>
          <header>
            <div><strong>{target.target_id}</strong><small>{target.host_kind} / {target.isolation_kind} · {target.environment_identity}</small></div>
            <div className="rho-resource-target-state">{target.selected && <span>Selected</span>}<span>{target.status}</span></div>
          </header>
          <p className={target.admission_allowed ? "rho-resource-admission-ready" : "rho-resource-admission-blocked"}>
            {target.admission_allowed ? "Resource admission ready" : "Resource admission guarded"}
          </p>
          {target.device != null && <>
            <div className="rho-resource-device"><strong>{target.device.host_name}</strong><small>{target.device.device_id} · {target.device.operating_system} {target.device.architecture}</small></div>
            <div className="rho-resource-metrics">
              {target.device.metrics.map((metric) => {
                const available = formatBytes(metric.available);
                const capacity = formatBytes(metric.capacity);
                return <div className={`rho-resource-metric rho-resource-pressure-${metric.pressure}`} key={metric.resource_id}>
                  <div><strong>{metric.label}</strong><span>{formatPercent(metric.utilization_basis_points)}</span></div>
                  {metric.utilization_basis_points != null && <progress max={10000} value={metric.utilization_basis_points} aria-label={`${metric.label} utilization`} />}
                  <small>{available != null && capacity != null ? `${available} available of ${capacity}` : metric.detail}</small>
                </div>;
              })}
            </div>
          </>}
          <ul className="rho-resource-governance-reasons">{target.governance_reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>
          {target.error != null && <p className="rho-resource-monitor-error">{target.error}</p>}
        </article>)}
      </div>
      <small className="rho-resource-observed-at">Observed {new Date(view.observed_at).toLocaleTimeString()}</small>
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
  const resourceMode = instance.mode_id === "resources";
  const mode: EnvironmentMode = instance.mode_id === "requests" ? "requests" : "packages";
  const [filter, setFilter] = useState(initialFilter);
  const [searchOpen, setSearchOpen] = useState(Boolean(initialFilter));
  const [data, setData] = useState<DomainSurfaceData | null>(null);
  const [toolchain, setToolchain] = useState<ToolchainDoctorView | null>(null);
  const [resources, setResources] = useState<ResourceMonitorView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const loadingRef = useRef(false);
  const load = useCallback(async () => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);
    try {
      if (toolchainMode) {
        setToolchain(await transport.toolchainDoctor());
        setResources(null);
        setData(null);
      } else if (resourceMode) {
        setResources(await transport.resourceMonitorSnapshot());
        setToolchain(null);
        setData(null);
      } else {
        setData(await transport.loadDomainSurface(instance.surface_id));
        setToolchain(null);
        setResources(null);
      }
      setError(null);
    } catch (cause: unknown) {
      setError(workbenchFailureMessage(cause, "Environment could not load."));
    } finally {
      loadingRef.current = false;
      setLoading(false);
    }
  }, [instance.surface_id, resourceMode, toolchainMode, transport]);
  useEffect(() => {
    void load();
    return transport.subscribeInvalidated(() => void load());
  }, [load, transport]);
  useEffect(() => {
    if (!resourceMode) return;
    const timer = window.setInterval(() => void load(), 15_000);
    return () => window.clearInterval(timer);
  }, [load, resourceMode]);
  if (toolchainMode) {
    return <ToolchainDoctorPanel
      view={toolchain}
      loading={loading}
      error={error}
      reload={load}
    />;
  }
  if (resourceMode) {
    return <ResourceMonitorPanel
      view={resources}
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
