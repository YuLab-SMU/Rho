import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type {
  AgentContextCapacityRequest,
  AgentLlmSettingsView,
  SurfaceFactoryRegistration,
  SurfaceInstance,
  UiKernelTransport,
} from "../transport";
import { SurfaceTaskState } from "./SurfaceTaskState";

export type SettingsModuleId = "models" | "components";

export interface SettingsModuleDefinition {
  readonly module_id: SettingsModuleId;
  readonly label: string;
  readonly description: string;
}

export const SETTINGS_MODULES: readonly SettingsModuleDefinition[] = [{
  module_id: "models",
  label: "Models",
  description: "Review model routing, Provider readiness, and context capacity.",
}, {
  module_id: "components",
  label: "Components",
  description: "Inspect the trusted application and current project component catalog.",
}];

const SETTINGS_MODULE_IDS = new Set<SettingsModuleId>(
  SETTINGS_MODULES.map((module) => module.module_id),
);

export function settingsModuleFromViewState(viewState: unknown): SettingsModuleId {
  if (typeof viewState !== "object" || viewState == null || !("module_id" in viewState)) {
    return "models";
  }
  const moduleId = viewState.module_id;
  return typeof moduleId === "string" && SETTINGS_MODULE_IDS.has(moduleId as SettingsModuleId)
    ? moduleId as SettingsModuleId
    : "models";
}

type SettingsLoadState =
  | { readonly status: "loading" }
  | { readonly status: "failed"; readonly message: string }
  | { readonly status: "ready"; readonly view: AgentLlmSettingsView };

type OperationState =
  | { readonly status: "idle"; readonly message: null }
  | { readonly status: "working" | "success" | "error"; readonly message: string };

function boundedMessage(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : String(error);
  return (message.trim() || fallback).slice(0, 512);
}

function readable(value: string): string {
  return value.replaceAll("_", " ");
}

function ModelsSettingsModule({
  state,
  operation,
  reload,
  mutate,
  selectChat,
  setCapacity,
}: {
  readonly state: SettingsLoadState;
  readonly operation: OperationState;
  readonly reload: () => void;
  readonly mutate: (
    label: string,
    operation: (view: AgentLlmSettingsView) => Promise<AgentLlmSettingsView>,
  ) => Promise<void>;
  readonly selectChat: (modelId: string, expectedRevision: number) => Promise<AgentLlmSettingsView>;
  readonly setCapacity: (request: AgentContextCapacityRequest) => Promise<AgentLlmSettingsView>;
}) {
  const view = state.status === "ready" ? state.view : null;
  const [capacityModelId, setCapacityModelId] = useState("");
  const capacityModel = view?.models.find((model) => model.id === capacityModelId)
    ?? view?.models.find((model) => model.selected)
    ?? view?.models[0]
    ?? null;
  const [contextTokens, setContextTokens] = useState("");
  const [reservedTokens, setReservedTokens] = useState("");
  const [validationMessage, setValidationMessage] = useState<string | null>(null);

  useEffect(() => {
    if (view == null || view.models.length === 0) {
      setCapacityModelId("");
      return;
    }
    if (!view.models.some((model) => model.id === capacityModelId)) {
      setCapacityModelId(view.models.find((model) => model.selected)?.id ?? view.models[0]!.id);
    }
  }, [capacityModelId, view]);

  useEffect(() => {
    if (capacityModel == null) {
      setContextTokens("");
      setReservedTokens("");
      return;
    }
    setContextTokens(String(capacityModel.context_window_tokens));
    setReservedTokens(String(capacityModel.reserved_output_tokens));
    setValidationMessage(null);
  }, [
    capacityModel?.context_window_tokens,
    capacityModel?.id,
    capacityModel?.reserved_output_tokens,
  ]);

  if (state.status === "loading") {
    return <SurfaceTaskState tone="loading" title="Loading model settings" detail="Reading the presentation-safe global settings view." role="status" busy />;
  }
  if (state.status === "failed") {
    return <SurfaceTaskState tone="error" title="Model settings are unavailable" detail={state.message} role="alert">
      <button type="button" onClick={reload}>Retry</button>
    </SurfaceTaskState>;
  }
  if (view == null) return null;

  const languageModels = view.models.filter((model) =>
    model.enabled && model.model_type.value === "language"
  );
  const saveCapacity = () => {
    if (capacityModel == null) return;
    const contextWindow = Number(contextTokens);
    const reservedOutput = Number(reservedTokens);
    if (!Number.isSafeInteger(contextWindow) || contextWindow < 4_096
        || !Number.isSafeInteger(reservedOutput) || reservedOutput < 256
        || reservedOutput >= contextWindow) {
      setValidationMessage("Use whole-token values: context at least 4,096; reserved output at least 256 and smaller than context.");
      return;
    }
    setValidationMessage(null);
    void mutate("Saving model capacity", (current) => {
      if (!current.models.some((model) => model.id === capacityModel.id)) {
        return Promise.reject(new Error("The selected model changed. Refresh Settings and try again."));
      }
      return setCapacity({
        model_id: capacityModel.id,
        expected_revision: current.revision,
        context_window_tokens: contextWindow,
        reserved_output_tokens: reservedOutput,
      });
    });
  };

  return <div className="rho-settings-module rho-settings-models">
    <header className="rho-settings-module-heading">
      <div><span className="rho-eyebrow">Models</span><h2>Model routing</h2></div>
      <button type="button" onClick={reload} disabled={operation.status === "working"}>Refresh</button>
    </header>
    {view.validation_error != null && (
      <p className="rho-settings-notice rho-settings-notice-error" role="alert">{view.validation_error}</p>
    )}
    {operation.status !== "idle" && (
      <p className={`rho-settings-operation rho-settings-operation-${operation.status}`} role={operation.status === "error" ? "alert" : "status"} aria-live="polite">
        {operation.message}
      </p>
    )}
    <section className="rho-settings-section" aria-labelledby="rho-settings-chat-heading">
      <div className="rho-settings-section-heading">
        <div><h3 id="rho-settings-chat-heading">Chat model</h3><p>One explicit enabled language model serves ordinary Ask and Plan turns.</p></div>
        <span>revision {view.revision}</span>
      </div>
      {languageModels.length === 0 ? (
        <SurfaceTaskState tone="empty" title="No enabled language model" detail="A trusted Connections/Model library module is required before Chat can be assigned." role="status" />
      ) : (
        <div className="rho-settings-card-grid">
          {languageModels.map((model) => {
            const current = model.id === view.selected_model_id;
            return <article className="rho-settings-card" aria-current={current || undefined} key={model.id}>
              <div>
                <strong>{model.display_name}</strong>
                <small>{model.provider_display_name} · {model.model_id}</small>
              </div>
              <div className="rho-settings-badges">
                <span>{readable(model.selector_status)}</span>
                <span>{readable(model.context_capacity_source)}</span>
              </div>
              {current
                ? <span className="rho-settings-current">Current Chat model</span>
                : <button
                    type="button"
                    disabled={operation.status === "working"}
                    onClick={() => void mutate(`Assigning ${model.display_name} to Chat`, (latest) =>
                      selectChat(model.id, latest.revision)
                    )}
                  >Use for Chat</button>}
            </article>;
          })}
        </div>
      )}
    </section>
    <section className="rho-settings-section" aria-labelledby="rho-settings-connections-heading">
      <div className="rho-settings-section-heading">
        <div><h3 id="rho-settings-connections-heading">Connections</h3><p>Credential values stay outside this Surface; only configured source and status are projected.</p></div>
      </div>
      {view.providers.length === 0 ? <p className="rho-settings-empty">No Providers are configured.</p> : (
        <div className="rho-settings-list">
          {view.providers.map((provider) => <article key={provider.id}>
            <div><strong>{provider.display_name}</strong><small>{provider.kind}</small></div>
            <dl>
              <div><dt>Source</dt><dd>{readable(provider.credential_source)}</dd></div>
              <div><dt>Status</dt><dd>{readable(provider.credential_status)}</dd></div>
              <div><dt>Effective</dt><dd>{readable(provider.credential_effective_source)}</dd></div>
            </dl>
          </article>)}
        </div>
      )}
    </section>
    <section className="rho-settings-section" aria-labelledby="rho-settings-capacity-heading">
      <div className="rho-settings-section-heading">
        <div><h3 id="rho-settings-capacity-heading">Context capacity</h3><p>Declare the context and reserved output budget for one configured model.</p></div>
      </div>
      {capacityModel == null ? <p className="rho-settings-empty">No model capacity is available.</p> : (
        <form className="rho-settings-capacity" onSubmit={(event) => { event.preventDefault(); saveCapacity(); }}>
          <label>Model<select aria-label="Capacity model" value={capacityModel.id} onChange={(event) => setCapacityModelId(event.target.value)}>
            {view.models.map((model) => <option value={model.id} key={model.id}>{model.display_name}</option>)}
          </select></label>
          <label>Context window<input aria-label="Settings context window tokens" inputMode="numeric" value={contextTokens} onChange={(event) => setContextTokens(event.target.value)} /></label>
          <label>Reserved output<input aria-label="Settings reserved output tokens" inputMode="numeric" value={reservedTokens} onChange={(event) => setReservedTokens(event.target.value)} /></label>
          <div><small>{readable(capacityModel.context_capacity_source)}</small><button type="submit" disabled={operation.status === "working"}>Save capacity</button></div>
          {validationMessage != null && <p role="alert">{validationMessage}</p>}
        </form>
      )}
    </section>
    <section className="rho-settings-section" aria-labelledby="rho-settings-routes-heading">
      <div className="rho-settings-section-heading">
        <div><h3 id="rho-settings-routes-heading">Capability routes</h3><p>Effective typed routes are shown without automatic Provider fallback.</p></div>
      </div>
      <div className="rho-settings-list">
        {view.capability_routes.map((route) => <article key={route.capability}>
          <div><strong>{route.label}</strong><small>{route.capability}</small></div>
          <dl>
            <div><dt>Model</dt><dd>{route.model_display_name ?? "Not assigned"}</dd></div>
            <div><dt>Compatibility</dt><dd>{readable(route.compatibility)}</dd></div>
            <div><dt>Consumer</dt><dd>{readable(route.consumer_status)}</dd></div>
          </dl>
        </article>)}
      </div>
    </section>
  </div>;
}

function ComponentsSettingsModule({ factories }: { readonly factories: readonly SurfaceFactoryRegistration[] }) {
  const groups = useMemo(() => ({
    application: factories.filter((factory) => factory.definition.origin.kind === "application"),
    project: factories.filter((factory) => factory.definition.origin.kind === "workspace_plugin"),
  }), [factories]);
  const renderGroup = (label: string, items: readonly SurfaceFactoryRegistration[]) => <section className="rho-settings-section">
    <div className="rho-settings-section-heading"><div><h3>{label}</h3><p>{items.length} registered component{items.length === 1 ? "" : "s"}</p></div></div>
    {items.length === 0 ? <p className="rho-settings-empty">No components in this group.</p> : <div className="rho-settings-component-list">
      {[...items].sort((left, right) => left.definition.label.localeCompare(right.definition.label)).map((factory) => {
        const origin = factory.definition.origin;
        return <article key={`${factory.definition.surface_id}:${factory.activation_generation}`}>
          <div><strong>{factory.definition.label}</strong><code>{factory.definition.surface_id}</code></div>
          <p>{factory.definition.purpose}</p>
          <dl>
            <div><dt>Scope</dt><dd>{factory.definition.scope}</dd></div>
            <div><dt>Instances</dt><dd>{readable(factory.definition.instance_policy)}</dd></div>
            <div><dt>Origin</dt><dd>{origin.kind === "application" ? "Rho application" : origin.plugin_id}</dd></div>
          </dl>
        </article>;
      })}
    </div>}
  </section>;
  return <div className="rho-settings-module rho-settings-components">
    <header className="rho-settings-module-heading"><div><span className="rho-eyebrow">Components</span><h2>Component catalog</h2></div></header>
    <p className="rho-settings-intro">This view is informational. Component lifecycle, permissions, installation, and layout remain in their existing trusted workflows.</p>
    {renderGroup("Rho application", groups.application)}
    {renderGroup("Current project", groups.project)}
  </div>;
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
  const [settingsState, setSettingsState] = useState<SettingsLoadState>({ status: "loading" });
  const [operation, setOperation] = useState<OperationState>({ status: "idle", message: null });
  const generation = useRef(0);

  const reload = useCallback(() => {
    const current = generation.current + 1;
    generation.current = current;
    setSettingsState({ status: "loading" });
    setOperation({ status: "idle", message: null });
    void transport.loadAgentLlmSettings().then((view) => {
      if (generation.current === current) setSettingsState({ status: "ready", view });
    }).catch((error: unknown) => {
      if (generation.current === current) {
        setSettingsState({ status: "failed", message: boundedMessage(error, "Model settings could not be read.") });
      }
    });
  }, [transport]);

  useEffect(() => {
    reload();
    return () => { generation.current += 1; };
  }, [reload]);

  const mutate = async (
    label: string,
    operationCall: (view: AgentLlmSettingsView) => Promise<AgentLlmSettingsView>,
  ) => {
    if (settingsState.status !== "ready" || operation.status === "working") return;
    const before = settingsState.view;
    setOperation({ status: "working", message: `${label}…` });
    try {
      const view = await operationCall(before);
      setSettingsState({ status: "ready", view });
      setOperation({ status: "success", message: `${label} completed.` });
    } catch (error: unknown) {
      const failure = boundedMessage(error, `${label} failed.`);
      try {
        const latest = await transport.loadAgentLlmSettings();
        setSettingsState({ status: "ready", view: latest });
        setOperation({ status: "error", message: `${failure} Durable settings were reloaded.`.slice(0, 512) });
      } catch (reloadError: unknown) {
        setSettingsState({ status: "ready", view: before });
        setOperation({
          status: "error",
          message: `${failure} Refresh also failed: ${boundedMessage(reloadError, "settings unavailable")}`.slice(0, 512),
        });
      }
    }
  };

  return <div className="rho-settings-surface">
    <nav className="rho-settings-nav" aria-label="Settings modules" role="tablist">
      {SETTINGS_MODULES.map((module) => <button
        type="button"
        role="tab"
        aria-selected={activeModule === module.module_id}
        key={module.module_id}
        onClick={() => {
          setActiveModule(module.module_id);
          void persist({ module_id: module.module_id }).catch(reportError);
        }}
      ><strong>{module.label}</strong><small>{module.description}</small></button>)}
    </nav>
    <section className="rho-settings-content" role="tabpanel" aria-label={SETTINGS_MODULES.find((module) => module.module_id === activeModule)?.label}>
      {activeModule === "models" ? <ModelsSettingsModule
        state={settingsState}
        operation={operation}
        reload={reload}
        mutate={mutate}
        selectChat={(modelId, expectedRevision) => transport.selectAgentChatModel(modelId, expectedRevision)}
        setCapacity={(request) => transport.setAgentContextCapacity(request)}
      /> : <ComponentsSettingsModule factories={factories} />}
    </section>
  </div>;
}
