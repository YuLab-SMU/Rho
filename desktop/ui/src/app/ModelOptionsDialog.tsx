import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";

import type {
  AgentLlmSettingsView,
  AgentModelProfile,
  UiKernelTransport,
} from "../transport";
import { MODEL_CAPABILITY_NAMES } from "../transport";

type ConfiguredModel = AgentLlmSettingsView["models"][number];

function readable(value: string): string {
  return value.replaceAll("_", " ");
}

function boundedMessage(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : String(error);
  return (message.trim() || fallback).slice(0, 320);
}

function evidenceMarker(source: string): string {
  switch (source) {
    case "provider_response":
    case "aisdk_catalog":
    case "catalog": return "(auto)";
    case "user_declared": return "(declared)";
    default: return "(unknown)";
  }
}

const DECLARATION_ORDER: readonly string[] = ["model_type", ...MODEL_CAPABILITY_NAMES];

/**
 * SETTINGS-UX2B: modal Model options dialog. One batched Save runs the
 * details upsert, the revision-safe capacity declaration, then one capability
 * declaration per changed row, each chained on the latest returned revision.
 * Cancel discards every draft without a single transport call.
 */
export function ModelOptionsDialog({
  model,
  revision,
  configSnapshotId,
  transport,
  applyView,
  onFeedback,
  onClose,
}: {
  readonly model: ConfiguredModel;
  readonly revision: number;
  readonly configSnapshotId: string;
  readonly transport: UiKernelTransport;
  readonly applyView: (view: AgentLlmSettingsView) => void;
  readonly onFeedback: (feedback: { readonly status: "success" | "error"; readonly message: string }) => void;
  readonly onClose: () => void;
}) {
  const [initial] = useState(() => ({
    displayName: model.display_name,
    modelId: model.model_id,
    enabled: model.enabled,
    contextWindow: model.context_capacity_source === "conservative_default"
      ? ""
      : String(model.context_window_tokens),
    reservedOutput: model.context_capacity_source === "conservative_default"
      ? ""
      : String(model.reserved_output_tokens),
    capabilities: Object.fromEntries(DECLARATION_ORDER.map((name) => [
      name,
      name === "model_type" ? model.model_type.value : model.capabilities[name]?.value ?? "unknown",
    ])),
  }));
  const [displayName, setDisplayName] = useState(initial.displayName);
  const [modelId, setModelId] = useState(initial.modelId);
  const [enabled, setEnabled] = useState(initial.enabled);
  const [contextWindow, setContextWindow] = useState(initial.contextWindow);
  const [reservedOutput, setReservedOutput] = useState(initial.reservedOutput);
  const [capabilityValues, setCapabilityValues] = useState<Readonly<Record<string, string>>>(initial.capabilities);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const firstFieldRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    firstFieldRef.current?.focus();
  }, []);

  const close = () => {
    if (!busy) onClose();
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      close();
      return;
    }
    if (event.key !== "Tab") return;
    const items = [...(panelRef.current?.querySelectorAll<HTMLElement>("button, input, select") ?? [])]
      .filter((element) => !element.hasAttribute("disabled"));
    if (items.length === 0) return;
    const first = items[0]!;
    const last = items[items.length - 1]!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const save = async () => {
    if (busy) return;
    setError(null);
    const trimmedId = modelId.trim();
    if (trimmedId === "") {
      setError("Enter a model ID before saving.");
      return;
    }
    const capacityTouched = contextWindow !== initial.contextWindow
      || reservedOutput !== initial.reservedOutput;
    let windowTokens = 0;
    let outputTokens = 0;
    if (capacityTouched) {
      if (contextWindow.trim() === "" || reservedOutput.trim() === "") {
        setError("Capacity is declared as a pair — enter both context window and max output limits.");
        return;
      }
      windowTokens = Number(contextWindow);
      outputTokens = Number(reservedOutput);
      if (!Number.isInteger(windowTokens) || !Number.isInteger(outputTokens)
          || windowTokens <= 0 || outputTokens <= 0) {
        setError("Enter whole-token context and output limits before saving.");
        return;
      }
    }
    const detailsChanged = displayName.trim() !== initial.displayName
      || trimmedId !== initial.modelId
      || enabled !== initial.enabled;
    const changedCapabilities = DECLARATION_ORDER.filter((name) =>
      capabilityValues[name] !== initial.capabilities[name]);
    setBusy(true);
    try {
      let currentRevision = revision;
      let currentConfigSnapshotId = configSnapshotId;
      if (detailsChanged) {
        const profile: AgentModelProfile = {
          id: model.id,
          provider_id: model.provider_id,
          display_name: displayName.trim() || trimmedId,
          model_id: trimmedId,
          enabled,
          // Type and capability evidence stay immutable through this command.
          model_type: { value: model.model_type.value, source: model.model_type.source },
          capabilities: Object.fromEntries(Object.entries(model.capabilities)
            .map(([name, capability]) => [name, { value: capability.value, source: capability.source }])),
          context_window_tokens: model.context_window_tokens,
          reserved_output_tokens: model.reserved_output_tokens,
          context_capacity_source: model.context_capacity_source,
          last_test: model.last_test == null ? null : { ...model.last_test },
        };
        const next = await transport.saveModel({
          model: profile,
          expectedRevision: currentRevision,
          expectedConfigSnapshotId: currentConfigSnapshotId,
        });
        applyView(next);
        currentRevision = next.revision;
        currentConfigSnapshotId = next.config_store.config_snapshot_id;
      }
      if (capacityTouched) {
        const next = await transport.setModelContextCapacity({
          modelId: model.id,
          expectedRevision: currentRevision,
          expectedConfigSnapshotId: currentConfigSnapshotId,
          contextWindowTokens: windowTokens,
          reservedOutputTokens: outputTokens,
        });
        applyView(next);
        currentRevision = next.revision;
        currentConfigSnapshotId = next.config_store.config_snapshot_id;
      }
      for (const capability of changedCapabilities) {
        const next = await transport.declareModelCapability({
          modelId: model.id,
          expectedRevision: currentRevision,
          expectedConfigSnapshotId: currentConfigSnapshotId,
          capability,
          value: capabilityValues[capability]!,
        });
        applyView(next);
        currentRevision = next.revision;
        currentConfigSnapshotId = next.config_store.config_snapshot_id;
      }
      onFeedback({ status: "success", message: "Model options saved." });
      onClose();
    } catch (saveError: unknown) {
      setError(boundedMessage(saveError, "Model options could not be saved."));
      try {
        applyView(await transport.loadAgentLlmSettings());
      } catch {
        // The dialog already carries the save failure; a failed reload adds nothing.
      }
    } finally {
      setBusy(false);
    }
  };

  return <div
    className="rho-settings-dialog-scrim"
    onMouseDown={(event) => {
      if (event.target === event.currentTarget) close();
    }}
  >
    <div
      className="rho-settings-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="rho-settings-model-options-heading"
      ref={panelRef}
      onKeyDown={onKeyDown}
    >
      <header className="rho-settings-dialog-heading">
        <div>
          <span className="rho-eyebrow">{model.provider_display_name} · Model</span>
          <h2 id="rho-settings-model-options-heading">Model options</h2>
        </div>
        <code>{model.model_id}</code>
      </header>
      <form
        className="rho-settings-dialog-body"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <section className="rho-settings-dialog-section" aria-label="Identity">
          <div className="rho-settings-dialog-fields">
            <label>Display name<input
              ref={firstFieldRef}
              type="text"
              value={displayName}
              disabled={busy}
              onChange={(event) => setDisplayName(event.target.value)}
            /></label>
            <label>Model ID<input
              type="text"
              required
              value={modelId}
              disabled={busy}
              onChange={(event) => setModelId(event.target.value)}
            /></label>
            <label className="rho-settings-dialog-enabled">Enabled<input
              type="checkbox"
              checked={enabled}
              disabled={busy}
              onChange={(event) => setEnabled(event.target.checked)}
            /></label>
          </div>
        </section>
        <section className="rho-settings-dialog-section" aria-label="Model capabilities">
          <h3>Model capabilities</h3>
          <div className="rho-settings-dialog-toggle-row">
            <span>model type <small>{evidenceMarker(model.model_type.source)}</small></span>
            <select
              aria-label="Declare model type"
              value={capabilityValues.model_type}
              disabled={busy}
              onChange={(event) => setCapabilityValues((values) => ({
                ...values,
                model_type: event.target.value,
              }))}
            >
              {["language", "embedding", "image", "unknown"].map((option) =>
                <option key={option} value={option}>{readable(option)}</option>)}
            </select>
          </div>
          {MODEL_CAPABILITY_NAMES.map((name) => {
            const value = capabilityValues[name] ?? "unknown";
            const evidence = model.capabilities[name] ?? { value: "unknown", source: "unknown" };
            return <div className="rho-settings-dialog-toggle-row" key={name}>
              <span>{readable(name)} <small>{evidenceMarker(evidence.source)}</small></span>
              <input
                type="checkbox"
                className="rho-settings-switch"
                aria-label={`Declare ${readable(name)}`}
                checked={value === "yes"}
                ref={(element) => {
                  if (element != null) element.indeterminate = value === "unknown";
                }}
                disabled={busy}
                onChange={(event) => setCapabilityValues((values) => ({
                  ...values,
                  [name]: event.target.checked ? "yes" : "no",
                }))}
              />
            </div>;
          })}
        </section>
        <section className="rho-settings-dialog-section" aria-label="Capacity">
          <h3>Capacity</h3>
          <div className="rho-settings-dialog-capacity">
            <label>Context window<input
              type="number"
              min={4_096}
              step={1}
              placeholder="Not reported"
              value={contextWindow}
              disabled={busy}
              onChange={(event) => setContextWindow(event.target.value)}
            /></label>
            <label>Max output tokens<input
              type="number"
              min={256}
              step={1}
              placeholder="Not reported"
              value={reservedOutput}
              disabled={busy}
              onChange={(event) => setReservedOutput(event.target.value)}
            /></label>
          </div>
          <small>Declared limits become execution inputs with unverified local provenance.</small>
        </section>
        {error != null && <p className="rho-settings-operation rho-settings-operation-error" role="alert">{error}</p>}
        <footer className="rho-settings-dialog-footer">
          <button type="button" disabled={busy} onClick={close}>Cancel</button>
          <button type="submit" disabled={busy || modelId.trim() === ""}>{busy ? "Saving…" : "Save"}</button>
        </footer>
      </form>
    </div>
  </div>;
}
