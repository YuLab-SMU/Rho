import { useCallback, useEffect, useRef, useState } from "react";

import type { DomainSurfaceData, SurfaceInstance, UiKernelTransport } from "../transport";
import type {
  ComputeTargetListView,
  ConfigureSshTargetRequest,
  ResourceMonitorView,
  SshConnectionProbeView,
  ToolchainDoctorView,
} from "../transport/environment";
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

interface ConnectionDraft {
  readonly target_id: string;
  readonly host: string;
  readonly port: string;
  readonly username: string;
  readonly password: string;
  readonly remote_root: string;
  readonly identity_file: string;
  readonly cpu: boolean;
  readonly gpu: boolean;
  readonly install_managed_key: boolean;
  readonly select_for_project: boolean;
}

const EMPTY_CONNECTION: ConnectionDraft = {
  target_id: "",
  host: "",
  port: "22",
  username: "",
  password: "",
  remote_root: "",
  identity_file: "",
  cpu: true,
  gpu: false,
  install_managed_key: true,
  select_for_project: false,
};

function RemoteConnectionsPanel({ transport }: { readonly transport: UiKernelTransport }) {
  const [targets, setTargets] = useState<ComputeTargetListView | null>(null);
  const [draft, setDraft] = useState<ConnectionDraft>(EMPTY_CONNECTION);
  const [editingTargetId, setEditingTargetId] = useState<string | null>(null);
  const [probe, setProbe] = useState<SshConnectionProbeView | null>(null);
  const [busy, setBusy] = useState<"list" | "save" | null>("list");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const loadTargets = useCallback(async () => {
    try {
      setBusy((current) => current ?? "list");
      setTargets(await transport.computeTargetList());
      setError(null);
    } catch (cause: unknown) {
      setError(workbenchFailureMessage(cause, "Compute targets could not load."));
    } finally {
      setBusy((current) => current === "list" ? null : current);
    }
  }, [transport]);
  useEffect(() => { void loadTargets(); }, [loadTargets]);
  const probeRequest = (confirmedFingerprint: string | null) => ({
    host: draft.host.trim(),
    port: Number(draft.port),
    username: draft.username.trim(),
    password: draft.password || null,
    identity_file: draft.identity_file.trim() || null,
    confirmed_fingerprint: confirmedFingerprint,
  });
  const configure = async () => {
    setBusy("save");
    try {
      const scanned = await transport.remoteConnectionProbe(probeRequest(null));
      const selectedFingerprint = scanned.fingerprints.find((item) => item.algorithm === "ED25519")
        ?? scanned.fingerprints[0];
      if (selectedFingerprint == null) throw new Error("The SSH host did not offer a supported host key.");
      const capabilities = [draft.cpu ? "cpu" : null, draft.gpu ? "gpu" : null]
        .filter((value): value is string => value != null);
      const request: ConfigureSshTargetRequest = {
        target_id: draft.target_id.trim(),
        host: draft.host.trim(),
        port: Number(draft.port),
        username: draft.username.trim(),
        password: draft.password || null,
        confirmed_fingerprint: selectedFingerprint.sha256,
        remote_root: draft.remote_root.trim(),
        capabilities,
        install_managed_key: draft.install_managed_key,
        identity_file: draft.identity_file.trim() || null,
        select_for_project: draft.select_for_project,
      };
      const result = await transport.configureSshTarget(request);
      setProbe(result.probe);
      setDraft(EMPTY_CONNECTION);
      setEditingTargetId(null);
      await loadTargets();
      setNotice(result.project_selected
        ? `Target ${result.target.target_id} is connected and selected for this project.`
        : `Target ${result.target.target_id} is connected and ready to use.`);
      setError(null);
    } catch (cause: unknown) {
      setDraft((current) => ({ ...current, password: "" }));
      setError(workbenchFailureMessage(cause, "SSH target could not be configured."));
    } finally {
      setBusy(null);
    }
  };
  const update = <Key extends keyof ConnectionDraft>(key: Key, value: ConnectionDraft[Key]) => {
    setDraft((current) => ({ ...current, [key]: value }));
    if (["host", "port", "username"].includes(key)) {
      setProbe(null);
    }
  };
  const editTarget = (target: ComputeTargetListView["targets"][number]) => {
    if (target.host_kind !== "ssh") return;
    setEditingTargetId(target.target_id);
    setDraft({
      target_id: target.target_id,
      host: target.host ?? "",
      port: String(target.port ?? 22),
      username: target.username ?? "",
      password: "",
      remote_root: target.remote_root ?? "",
      identity_file: target.identity_file ?? "",
      cpu: target.capabilities.includes("cpu"),
      gpu: target.capabilities.includes("gpu"),
      install_managed_key: !target.identity_available,
      select_for_project: target.selected,
    });
    setProbe(null);
    setNotice(null);
    setError(null);
  };
  const cancelEdit = () => {
    setEditingTargetId(null);
    setDraft(EMPTY_CONNECTION);
    setProbe(null);
    setError(null);
  };
  return <section className="rho-remote-connections" aria-label="Remote environment connections">
    <header className="rho-environment-toolbar">
      <div><strong>Remote connections</strong><small>Connect SSH and Slurm environments without storing passwords.</small></div>
      <button type="button" className="rho-icon-btn" aria-label="Refresh connections" disabled={busy != null} onClick={() => void loadTargets()}>↻</button>
    </header>
    <div className="rho-remote-connections-body">
      {error != null && <SurfaceTaskState tone="error" title="Connection needs attention" detail={error} role="alert" />}
      {notice != null && <p className="rho-connection-notice" role="status"><strong>Connection saved.</strong> {notice}</p>}
      <section className="rho-connection-target-list" aria-label="Configured targets">
        <header><span className="rho-eyebrow">Configured targets</span><strong>{targets?.targets.length ?? 0}</strong></header>
        {targets?.targets.map((target) => <article data-target-id={target.target_id} data-editing={editingTargetId === target.target_id || undefined} key={target.target_id}>
          <div><strong>{target.target_id}</strong><small>{target.host_kind === "ssh" ? `${target.username ?? "user"}@${target.host}:${target.port}` : "This device"}</small></div>
          <div className="rho-connection-target-actions">
            <span className={`rho-domain-state rho-domain-${target.selected ? "ready" : target.identity_available ? "current" : "warning"}`}>{target.selected ? "selected" : target.identity_available ? "ready" : "key missing"}</span>
            {target.host_kind === "ssh" && <button type="button" onClick={() => editTarget(target)}>Edit</button>}
          </div>
          <p>{target.isolation_kind} · {target.capabilities.join(", ") || "no capabilities"}{target.remote_root == null ? "" : ` · ${target.remote_root}`}</p>
        </article>)}
        {busy === "list" && targets == null && <SurfaceTaskState tone="loading" title="Loading connections…" detail="Reading the device-local target registry." role="status" busy />}
      </section>
      <section className="rho-connection-wizard" aria-label={editingTargetId == null ? "Add SSH target" : "Edit SSH target"}>
        <header><span className="rho-eyebrow">{editingTargetId == null ? "Add SSH / Slurm target" : "Edit SSH / Slurm target"}</span><strong>{editingTargetId == null ? "Connection details" : editingTargetId}</strong></header>
        <div className="rho-connection-fields">
          <label className="rho-connection-wide">Address<input value={draft.host} onChange={(event) => update("host", event.target.value)} placeholder="hpc.example.edu" /></label>
          <label>Username<input autoComplete="username" value={draft.username} onChange={(event) => update("username", event.target.value)} /></label>
          <label>SSH port<input type="number" min="1" max="65535" value={draft.port} onChange={(event) => update("port", event.target.value)} /></label>
          <label className="rho-connection-wide">Password {editingTargetId != null && "(optional)"}<input type="password" autoComplete="current-password" value={draft.password} onChange={(event) => update("password", event.target.value)} placeholder={editingTargetId == null ? "Used once; never saved" : "Only needed to replace the SSH key"} /></label>
        </div>
        <details className="rho-connection-advanced">
          <summary>Advanced options</summary>
          <div className="rho-connection-fields">
            <label>Target name {editingTargetId == null && "(optional)"}<input value={draft.target_id} onChange={(event) => update("target_id", event.target.value)} placeholder="Generated automatically" disabled={editingTargetId != null} /></label>
            <label>Remote folder (optional)<input value={draft.remote_root} onChange={(event) => update("remote_root", event.target.value)} placeholder="Remote home directory" /></label>
            <label className="rho-connection-wide">Existing private key<input value={draft.identity_file} onChange={(event) => update("identity_file", event.target.value)} placeholder="/Users/me/.ssh/id_ed25519" disabled={draft.install_managed_key} /></label>
          </div>
          <div className="rho-connection-options">
            <label><input type="checkbox" checked={draft.cpu} onChange={(event) => update("cpu", event.target.checked)} /> CPU</label>
            <label><input type="checkbox" checked={draft.gpu} onChange={(event) => update("gpu", event.target.checked)} /> GPU required</label>
            <label><input type="checkbox" checked={draft.install_managed_key} onChange={(event) => update("install_managed_key", event.target.checked)} /> Install or repair a managed Rho key</label>
            <label><input type="checkbox" checked={draft.select_for_project} onChange={(event) => update("select_for_project", event.target.checked)} /> Use for this project now</label>
          </div>
        </details>
        <p className="rho-connection-secret-note">Rho confirms the host key, detects Slurm, installs a dedicated key and the matching remote Helper, then saves the connection automatically. The password is cleared when setup finishes.</p>
        <div className="rho-connection-actions">
          <button type="button" className="rho-primary-action" disabled={busy != null || !draft.host.trim() || !draft.username.trim() || (draft.install_managed_key && !draft.password && !draft.identity_file)} onClick={() => void configure()}>{busy === "save" ? "Connecting and configuring…" : editingTargetId == null ? "Connect automatically" : "Save & verify"}</button>
          {editingTargetId != null && <button type="button" disabled={busy != null} onClick={cancelEdit}>Cancel edit</button>}
        </div>
        {probe != null && <section className="rho-connection-probe" aria-label="SSH probe result">
          <header><strong>{probe.status === "ready" ? probe.host_name ?? "SSH ready" : "Confirm host identity"}</strong><span className={`rho-domain-state rho-domain-${probe.authenticated ? "ready" : "warning"}`}>{probe.status}</span></header>
          <p>{probe.message}</p>
          <details className="rho-connection-security"><summary>Verified host identity</summary><div className="rho-connection-fingerprints">{probe.fingerprints.map((item) => <div key={item.sha256}>
            <span><strong>{item.algorithm}</strong><code>{item.sha256}</code></span>
          </div>)}</div></details>
          {probe.slurm_version != null && <div className="rho-slurm-summary"><strong>{probe.slurm_version}</strong>{probe.partitions.map((partition) => <span key={partition.partition}>{partition.partition} · {partition.nodes} node(s) · {partition.gres} · CPU {partition.cpus}</span>)}</div>}
          {probe.authenticated && <p className={probe.helper_available ? "rho-connection-helper-ready" : "rho-connection-helper-missing"}>{probe.helper_available ? "Rho remote Helper ready" : "Rho remote Helper is not installed yet; monitoring works after target setup, execution remains guarded."}</p>}
        </section>}
      </section>
    </div>
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

type ResourceMetric = NonNullable<ResourceMonitorView["targets"][number]["device"]>["metrics"][number];

function TaskbarMetric({
  label,
  metric,
}: {
  readonly label: string;
  readonly metric: ResourceMetric | null;
}) {
  const value = metric?.utilization_basis_points ?? null;
  return <span className={`rho-environment-taskbar-metric rho-resource-pressure-${metric?.pressure ?? "unavailable"}`} title={metric?.detail ?? `${label} telemetry unavailable`}>
    <span>{label}</span>
    <strong>{value == null ? "—" : formatPercent(value)}</strong>
    <progress max={10000} value={value ?? 0} aria-hidden="true" />
  </span>;
}

export function EnvironmentTaskbarPanel({
  transport,
  workspaceState,
  workspaceLabel,
  agentState,
  agentLabel,
  activeOperations,
  openResources,
  openConnections,
  openDiagnostics,
  diagnosticsAvailable,
}: {
  readonly transport: UiKernelTransport;
  readonly workspaceState: string;
  readonly workspaceLabel: string;
  readonly agentState: string;
  readonly agentLabel: string;
  readonly activeOperations: number;
  readonly openResources: () => void;
  readonly openConnections: () => void;
  readonly openDiagnostics: () => void;
  readonly diagnosticsAvailable: boolean;
}) {
  const [view, setView] = useState<ResourceMonitorView | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loadingRef = useRef(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const load = useCallback(async () => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    try {
      setView(await transport.resourceMonitorSnapshot());
      setError(null);
    } catch (cause: unknown) {
      setError(workbenchFailureMessage(cause, "Resource telemetry unavailable."));
    } finally {
      loadingRef.current = false;
    }
  }, [transport]);
  useEffect(() => {
    void load();
    return transport.subscribeInvalidated(() => void load());
  }, [load, transport]);
  useEffect(() => {
    const timer = window.setInterval(() => void load(), 10_000);
    return () => window.clearInterval(timer);
  }, [load]);
  useEffect(() => {
    if (!expanded) return;
    const closeOnKey = (event: KeyboardEvent) => { if (event.key === "Escape") setExpanded(false); };
    const closeOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && !panelRef.current?.contains(event.target)) setExpanded(false);
    };
    window.addEventListener("keydown", closeOnKey);
    document.addEventListener("pointerdown", closeOutside);
    return () => {
      window.removeEventListener("keydown", closeOnKey);
      document.removeEventListener("pointerdown", closeOutside);
    };
  }, [expanded]);

  const target = view?.targets.find((candidate) => candidate.selected) ?? view?.targets[0] ?? null;
  const metrics = target?.device?.metrics ?? [];
  const cpu = metrics.find((metric) => metric.kind === "cpu") ?? null;
  const memory = metrics.find((metric) => metric.kind === "memory") ?? null;
  const disk = metrics.find((metric) => metric.kind === "disk") ?? null;
  return <div className="rho-environment-taskbar" ref={panelRef}>
    <button
      type="button"
      className="rho-environment-taskbar-trigger"
      aria-label="Environment realtime information"
      aria-expanded={expanded}
      onClick={() => setExpanded((value) => !value)}
    >
      <TaskbarMetric label="CPU" metric={cpu} />
      <TaskbarMetric label="RAM" metric={memory} />
      <TaskbarMetric label="Disk" metric={disk} />
    </button>
    {expanded && <section className="rho-environment-taskbar-popover" role="dialog" aria-label="Environment realtime details">
      <header>
        <div><span className="rho-eyebrow">Environment realtime</span><strong>{target?.target_id ?? "Local environment"}</strong></div>
        <span className={`rho-domain-state rho-domain-${target?.status === "healthy" ? "ready" : target?.status === "critical" ? "error" : "warning"}`}>{target?.status ?? "loading"}</span>
      </header>
      <p>{target == null ? "Resource telemetry is loading." : `${target.host_kind} / ${target.isolation_kind} · ${target.environment_identity} · capabilities ${target.capabilities.join(", ") || "none declared"}`}</p>
      {target?.device != null && <div className="rho-environment-taskbar-device">
        <strong>{target.device.host_name}</strong>
        <small>{target.device.device_id} · {target.device.operating_system} {target.device.architecture} · {target.device.cpu_logical_count} logical CPUs</small>
      </div>}
      <div className="rho-environment-taskbar-detail-grid">
        {metrics.map((metric) => {
          const available = formatBytes(metric.available);
          const capacity = formatBytes(metric.capacity);
          return <div key={metric.resource_id}>
            <span>{metric.label}</span><strong>{formatPercent(metric.utilization_basis_points)}</strong>
            <small>{available != null && capacity != null ? `${available} free / ${capacity}` : metric.detail}</small>
          </div>;
        })}
      </div>
      <div className="rho-environment-taskbar-health">
        <span><i className={`rho-status-dot rho-status-${workspaceState}`} />{workspaceLabel}</span>
        <span><i className={`rho-status-dot rho-status-${agentState}`} />{agentLabel}</span>
        <span>{activeOperations} active {activeOperations === 1 ? "operation" : "operations"}</span>
      </div>
      {target != null && <p className={target.admission_allowed ? "rho-resource-admission-ready" : "rho-resource-admission-blocked"}>
        {target.admission_allowed ? "Resource admission ready" : "Resource admission guarded"} · {target.governance_reasons.join(" · ")}
      </p>}
      {error != null && <p className="rho-resource-monitor-error">{error}</p>}
      <footer>
        <button type="button" onClick={() => { setExpanded(false); openResources(); }}>Open Environment Resources</button>
        <button type="button" onClick={() => { setExpanded(false); openConnections(); }}>Remote Connections</button>
        <button type="button" disabled={!diagnosticsAvailable} onClick={() => { setExpanded(false); openDiagnostics(); }}>Diagnostics</button>
        <small>{view == null ? "Waiting for first observation" : `Updated ${new Date(view.observed_at).toLocaleTimeString()}`}</small>
      </footer>
    </section>}
  </div>;
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
  const connectionMode = instance.mode_id === "connections";
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
      } else if (connectionMode) {
        setResources(null);
        setToolchain(null);
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
  }, [connectionMode, instance.surface_id, resourceMode, toolchainMode, transport]);
  useEffect(() => {
    void load();
    return transport.subscribeInvalidated(() => void load());
  }, [load, transport]);
  useEffect(() => {
    if (!resourceMode) return;
    const timer = window.setInterval(() => void load(), 15_000);
    return () => window.clearInterval(timer);
  }, [load, resourceMode]);
  if (connectionMode) {
    return <RemoteConnectionsPanel transport={transport} />;
  }
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
