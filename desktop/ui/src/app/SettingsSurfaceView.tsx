import { useCallback, useEffect, useState } from "react";

import type {
  AgentRuntimeDiagnostics,
  SurfaceFactoryRegistration,
  SurfaceInstance,
  UiKernelTransport,
} from "../transport";
import { SurfaceTaskState } from "./SurfaceTaskState";
import {
  compareSurfaceCatalogOrder,
  surfaceCatalogPolicy,
  surfaceDisplayLabel,
} from "./surface-ux";

export type SettingsModuleId = "agents" | "components";

export interface SettingsModuleDefinition {
  readonly module_id: SettingsModuleId;
  readonly label: string;
  readonly description: string;
}

export const SETTINGS_MODULES: readonly SettingsModuleDefinition[] = [{
  module_id: "agents",
  label: "External Agents",
  description: "Inspect installed ACP Agents. Rho is their client, not their runtime.",
}, {
  module_id: "components",
  label: "Capabilities",
  description: "Inspect built-in capabilities and project extensions.",
}];

const SETTINGS_MODULE_IDS = new Set<SettingsModuleId>(
  SETTINGS_MODULES.map((module) => module.module_id),
);

export function settingsModuleFromViewState(viewState: unknown): SettingsModuleId {
  if (typeof viewState !== "object" || viewState == null || !("module_id" in viewState)) {
    return "agents";
  }
  const moduleId = viewState.module_id;
  return typeof moduleId === "string" && SETTINGS_MODULE_IDS.has(moduleId as SettingsModuleId)
    ? moduleId as SettingsModuleId
    : "agents";
}

function boundedMessage(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : String(error);
  return (message.trim() || fallback).slice(0, 320);
}

function ExternalAgentsModule({
  diagnostics,
  refresh,
  refreshing,
}: {
  readonly diagnostics: AgentRuntimeDiagnostics | null;
  readonly refresh: () => void;
  readonly refreshing: boolean;
}) {
  if (diagnostics == null) {
    return <SurfaceTaskState
      tone="loading"
      title="Discovering external ACP Agents…"
      detail="Checking installed ACP executables without starting an Agent session."
      role="status"
      busy
    />;
  }
  return <section className="rho-settings-acp" aria-label="External ACP Agents">
    <header>
      <div>
        <span className="rho-eyebrow">Agent Client Protocol</span>
        <h2>{diagnostics.available ? diagnostics.active_agent_label ?? "External Agent ready" : "No ACP Agent available"}</h2>
        <p>{diagnostics.available
          ? "Rho connects as an ACP client. Planning, models, tools, and sessions belong to the external Agent."
          : diagnostics.error ?? "Install an ACP-compatible Agent to enable the Agent Surface."}</p>
      </div>
      <button type="button" disabled={refreshing} onClick={refresh}>
        {refreshing ? "Refreshing…" : "Refresh"}
      </button>
    </header>
    <dl className="rho-settings-acp-facts">
      <div><dt>Status</dt><dd>{diagnostics.status.replaceAll("_", " ")}</dd></div>
      <div><dt>Protocol</dt><dd>{diagnostics.protocol ?? "Unavailable"}</dd></div>
      <div><dt>Executable</dt><dd><code>{diagnostics.executable ?? "Not found"}</code></dd></div>
      <div><dt>Authority</dt><dd>Rho Broker only</dd></div>
    </dl>
    <div className="rho-settings-acp-boundary">
      <strong>Boundary</strong>
      <span>External Agents receive disposable project context. Provider permission signals never prove a project, Run, Artifact, or Environment mutation completed.</span>
    </div>
    <div className="rho-settings-acp-list">
      {diagnostics.candidates.length === 0
        ? <p>No installed ACP executable was discovered on the child-process PATH.</p>
        : diagnostics.candidates.map((candidate) => <article key={candidate.agent_id}>
            <div>
              <strong>{candidate.display_name}</strong>
              <small>{candidate.agent_id}</small>
            </div>
            <span>{candidate.protocol ?? "Protocol unavailable"}</span>
            <code>{candidate.executable ?? "Not found"}</code>
          </article>)}
    </div>
  </section>;
}

function ComponentsSettingsModule({
  factories,
}: {
  readonly factories: readonly SurfaceFactoryRegistration[];
}) {
  const visible = [...factories]
    .filter((factory) => surfaceCatalogPolicy(factory.definition.surface_id).visibility !== "internal")
    .sort((left, right) => compareSurfaceCatalogOrder(
      left.definition.surface_id,
      right.definition.surface_id,
    ));
  return <section className="rho-settings-components" aria-label="Workbench capabilities">
    <header>
      <span className="rho-eyebrow">Workbench capabilities</span>
      <h2>{visible.length} available Surfaces</h2>
      <p>These are Rho UI capabilities. They do not extend an external Agent's authority.</p>
    </header>
    <div className="rho-settings-components-list">
      {visible.map((factory) => <article key={factory.definition.surface_id}>
        <strong>{surfaceDisplayLabel(factory.definition.surface_id)}</strong>
        <code>{factory.definition.surface_id}</code>
        <span>{surfaceCatalogPolicy(factory.definition.surface_id).visibility.replaceAll("_", " ")}</span>
      </article>)}
    </div>
  </section>;
}

export function SettingsSurfaceView({
  instance,
  transport,
  factories,
  persist,
  reportError,
}: {
  readonly instance: SurfaceInstance;
  readonly transport: UiKernelTransport;
  readonly factories: readonly SurfaceFactoryRegistration[];
  readonly persist: (viewState: unknown) => Promise<void>;
  readonly reportError: (error: unknown) => void;
}) {
  const [activeModule, setActiveModule] = useState<SettingsModuleId>(() =>
    settingsModuleFromViewState(instance.view_state)
  );
  const [diagnostics, setDiagnostics] = useState<AgentRuntimeDiagnostics | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async (retry: boolean) => {
    setRefreshing(true);
    setLoadError(null);
    try {
      const next = retry
        ? await transport.retryAgentRuntime()
        : await transport.getAgentRuntimeDiagnostics();
      setDiagnostics(next);
    } catch (error: unknown) {
      setLoadError(boundedMessage(error, "ACP Agent discovery failed."));
      reportError(error);
    } finally {
      setRefreshing(false);
    }
  }, [reportError, transport]);

  useEffect(() => {
    setActiveModule(settingsModuleFromViewState(instance.view_state));
  }, [instance.surface_revision, instance.view_state]);

  useEffect(() => {
    void load(false);
  }, [load]);

  const selectModule = (moduleId: SettingsModuleId) => {
    setActiveModule(moduleId);
    void persist({ module_id: moduleId }).catch(reportError);
  };

  return <section className="rho-settings-surface" aria-label="Settings">
    <nav className="rho-settings-nav" aria-label="Settings sections">
      {SETTINGS_MODULES.map((module) => <button
        type="button"
        aria-selected={activeModule === module.module_id}
        key={module.module_id}
        onClick={() => selectModule(module.module_id)}
      >
        <strong>{module.label}</strong>
        <small>{module.description}</small>
      </button>)}
    </nav>
    <div className="rho-settings-content">
      <div className="rho-settings-module">
        {loadError != null && <div role="alert" className="rho-settings-error">{loadError}</div>}
        {activeModule === "agents"
          ? <ExternalAgentsModule
              diagnostics={diagnostics}
              refresh={() => void load(true)}
              refreshing={refreshing}
            />
          : <ComponentsSettingsModule factories={factories} />}
      </div>
    </div>
  </section>;
}
