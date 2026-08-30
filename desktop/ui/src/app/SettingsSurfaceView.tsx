import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import type {
  AgentLlmCredentialRevealView,
  AgentLlmSettingsView,
  AgentModelDiscoveryResponse,
  SurfaceFactoryRegistration,
  SurfaceInstance,
  UiKernelTransport,
} from "../transport";
import { buildAddedModelProfile } from "../transport";
import type { AgentProviderProfile } from "../transport/agent-settings";
import { ModelOptionsDialog } from "./ModelOptionsDialog";
import { SurfaceTaskState } from "./SurfaceTaskState";
import {
  SURFACE_CAPABILITY_GROUPS,
  compareSurfaceCatalogOrder,
  surfaceCatalogPolicy,
  surfaceDisplayLabel,
} from "./surface-ux";

export type SettingsModuleId = "providers" | "components";

export interface SettingsModuleDefinition {
  readonly module_id: SettingsModuleId;
  readonly label: string;
  readonly description: string;
}

export const SETTINGS_MODULES: readonly SettingsModuleDefinition[] = [{
  module_id: "providers",
  label: "Providers",
  description: "Connect services Rho can use.",
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
    return "providers";
  }
  const moduleId = viewState.module_id;
  return typeof moduleId === "string" && SETTINGS_MODULE_IDS.has(moduleId as SettingsModuleId)
    ? moduleId as SettingsModuleId
    : "providers";
}

type SettingsLoadState =
  | { readonly status: "loading" }
  | { readonly status: "failed"; readonly message: string }
  | { readonly status: "ready"; readonly view: AgentLlmSettingsView };

type ProviderPage =
  | { readonly kind: "overview" }
  | { readonly kind: "provider"; readonly providerId: string }
  | { readonly kind: "model"; readonly providerId: string; readonly modelId: string; readonly remote: boolean };

type DiscoveryState =
  | { readonly status: "idle" }
  | { readonly status: "loading" }
  | { readonly status: "complete"; readonly response: AgentModelDiscoveryResponse };

type Feedback =
  | { readonly status: "idle"; readonly message: null }
  | { readonly status: "working" | "success" | "error"; readonly message: string };

type ProviderView = AgentLlmSettingsView["providers"][number];
type CredentialWriteTarget = "config_file" | "session";
type ProviderPresetId = "openai" | "anthropic" | "gemini" | "deepseek" | "openrouter" | "local" | "custom";

interface ProviderConnectDraft {
  readonly preset: ProviderPresetId;
  readonly displayName: string;
  readonly baseUrl: string;
  readonly apiKey: string;
}

const PROVIDER_PRESETS: Readonly<Record<ProviderPresetId, {
  readonly label: string;
  readonly kind: AgentProviderProfile["kind"];
  readonly registeredProviderId: string | null;
  readonly apiKeyEnv: string | null;
  readonly apiKeyRequired: boolean;
  readonly defaultBaseUrl: string;
  readonly wireApi: string | null;
}>> = {
  openai: { label: "OpenAI", kind: "openai", registeredProviderId: null, apiKeyEnv: "OPENAI_API_KEY", apiKeyRequired: true, defaultBaseUrl: "", wireApi: null },
  anthropic: { label: "Anthropic", kind: "anthropic", registeredProviderId: null, apiKeyEnv: "ANTHROPIC_API_KEY", apiKeyRequired: true, defaultBaseUrl: "", wireApi: null },
  gemini: { label: "Google Gemini", kind: "gemini", registeredProviderId: null, apiKeyEnv: "GEMINI_API_KEY", apiKeyRequired: true, defaultBaseUrl: "", wireApi: null },
  deepseek: { label: "DeepSeek", kind: "registered", registeredProviderId: "deepseek", apiKeyEnv: "DEEPSEEK_API_KEY", apiKeyRequired: true, defaultBaseUrl: "", wireApi: null },
  openrouter: { label: "OpenRouter", kind: "registered", registeredProviderId: "openrouter", apiKeyEnv: "OPENROUTER_API_KEY", apiKeyRequired: true, defaultBaseUrl: "", wireApi: null },
  local: { label: "Local OpenAI-compatible", kind: "local_openai_compatible", registeredProviderId: null, apiKeyEnv: null, apiKeyRequired: false, defaultBaseUrl: "http://127.0.0.1:11434/v1", wireApi: "chat_completions" },
  custom: { label: "Custom OpenAI-compatible", kind: "openai_compatible", registeredProviderId: null, apiKeyEnv: "RHO_CUSTOM_API_KEY", apiKeyRequired: true, defaultBaseUrl: "", wireApi: "chat_completions" },
};

function matchesCompatibleProvider(kind: string): boolean {
  return kind === "openai_compatible" || kind === "local_openai_compatible";
}

const EMPTY_PROVIDER_CONNECT: ProviderConnectDraft = {
  preset: "openai",
  displayName: "",
  baseUrl: "",
  apiKey: "",
};

const FIXED_CREDENTIAL_MASK = "••••••••••••••••";

function boundedMessage(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : String(error);
  return (message.trim() || fallback).slice(0, 320);
}

function readable(value: string): string {
  return value.replaceAll("_", " ");
}

function evidenceSourceLabel(source: string): string {
  switch (source) {
    case "provider_response": return "Provider test evidence";
    case "aisdk_catalog":
    case "catalog": return "Reviewed catalog evidence";
    case "user_declared": return "Unverified local metadata";
    case "unknown": return "No evidence";
    default: return "Unknown source";
  }
}

function capabilityPresentation(capability: { readonly value: string; readonly source: string }): {
  readonly value: string;
  readonly source: string;
} {
  if (capability.source === "provider_response"
      || capability.source === "aisdk_catalog"
      || capability.source === "catalog") {
    return {
      value: capability.value === "unknown" ? "Unknown" : readable(capability.value),
      source: evidenceSourceLabel(capability.source),
    };
  }
  if (capability.source === "user_declared") {
    // Declared evidence renders the declared value labelled by its unverified
    // provenance; it never masquerades as Provider or catalog evidence.
    return {
      value: capability.value === "unknown" ? "Unknown" : readable(capability.value),
      source: evidenceSourceLabel(capability.source),
    };
  }
  return {
    value: "Unknown",
    source: evidenceSourceLabel(capability.source),
  };
}

function formatCheckedAt(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString();
}

function formatLatency(value: number | null): string {
  return value == null ? "—" : `${value} ms`;
}

function providerReadiness(provider: ProviderView): string {
  if (!provider.api_key_required) return "Ready";
  if (provider.credential_status === "detected") return "Ready";
  if (provider.credential_status === "not_detected") return "Needs API key";
  if (provider.credential_status === "unavailable") return "Credential unavailable";
  return "Not checked";
}

function credentialSourceLabel(provider: ProviderView): string {
  switch (provider.credential_effective_source) {
    case "session": return "This session";
    case "environment": return provider.api_key_env == null
      ? "Environment"
      : `Environment · ${provider.api_key_env}`;
    case "config_file": return "config.yaml";
    case "not_configured": return "Not configured";
    default: return "Not configured";
  }
}

function credentialLooksSaved(provider: ProviderView): boolean {
  return provider.credential_status === "detected";
}

function targetHasCredential(provider: ProviderView, target: CredentialWriteTarget): boolean {
  return target === "session"
    ? provider.session_credential_present
    : provider.config_file_credential_present;
}

function revealOutcomeMessage(outcome: AgentLlmCredentialRevealView["outcome"]): string {
  switch (outcome) {
    case "credential_missing":
      return "No saved API key was found. Add it again.";
    case "credential_unavailable":
      return "The effective API key could not be read.";
    case "revealed":
      // A revealed outcome without a value is degenerate; treat it as missing.
      return "No saved API key was found. Add it again.";
  }
}

function configStoreStatusLabel(status: AgentLlmSettingsView["config_store"]["status"]): string {
  switch (status) {
    case "loaded": return "Loaded";
    case "missing": return "Missing";
    case "malformed": return "Needs repair";
    case "unsupported_schema_version": return "Unsupported schema";
    case "home_unavailable": return "Home unavailable";
    default: return "Unavailable";
  }
}

function configStoreDetail(store: AgentLlmSettingsView["config_store"]): string {
  switch (store.status) {
    case "loaded":
      return "Provider settings and saved API keys use this canonical file.";
    case "missing":
      return "Rho will create the configuration automatically when the first Provider is connected.";
    case "malformed":
      return store.detail ?? "The configuration file is not valid V6 YAML. Fix it, then refresh.";
    case "unsupported_schema_version":
      return store.found_schema_version == null
        ? "The configuration file uses an unsupported schema version."
        : `Schema version ${store.found_schema_version} is not supported; Rho expects version 6.`;
    case "home_unavailable":
      return "Rho could not resolve device-local settings storage. Choose a valid Rho Home, then retry.";
    default:
      return store.detail ?? "The configuration file is unavailable.";
  }
}

function permissionMode(value: number): string {
  return value.toString(8).padStart(4, "0");
}

function BackButton({ label, onClick }: { readonly label: string; readonly onClick: () => void }) {
  return <button type="button" className="rho-settings-back" onClick={onClick}>← {label}</button>;
}

function FeedbackBanner({ feedback }: { readonly feedback: Feedback }) {
  if (feedback.status === "idle") return null;
  return <p
    className={`rho-settings-operation rho-settings-operation-${feedback.status}`}
    role={feedback.status === "error" ? "alert" : "status"}
    aria-live="polite"
  >{feedback.message}</p>;
}

function ProvidersSettingsModule({
  view,
  transport,
  applyView,
  refresh,
}: {
  readonly view: AgentLlmSettingsView;
  readonly transport: UiKernelTransport;
  readonly applyView: (view: AgentLlmSettingsView) => void;
  readonly refresh: () => void;
}) {
  const [page, setPage] = useState<ProviderPage>({ kind: "overview" });
  const [feedback, setFeedback] = useState<Feedback>({ status: "idle", message: null });
  const [credentialDraft, setCredentialDraft] = useState("");
  const [credentialMode, setCredentialMode] = useState<"add" | "replace" | null>(null);
  const [credentialTarget, setCredentialTarget] = useState<CredentialWriteTarget>("config_file");
  const [discovery, setDiscovery] = useState<DiscoveryState>({ status: "idle" });
  const [testingModelId, setTestingModelId] = useState<string | null>(null);
  const [revealedCredential, setRevealedCredential] = useState<{ readonly providerId: string; readonly value: string } | null>(null);
  const [viewingCredential, setViewingCredential] = useState(false);
  const [modelOptionsOpen, setModelOptionsOpen] = useState(false);
  const [modelMutation, setModelMutation] = useState<null | "add" | "manual" | "delete">(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [manualAddOpen, setManualAddOpen] = useState(false);
  const [manualAddDraft, setManualAddDraft] = useState({ modelId: "", displayName: "" });
  const [providerConnectOpen, setProviderConnectOpen] = useState(false);
  const [providerConnectDraft, setProviderConnectDraft] = useState<ProviderConnectDraft>(EMPTY_PROVIDER_CONNECT);
  const editButtonRef = useRef<HTMLButtonElement>(null);
  const draftInput = useRef<HTMLInputElement>(null);
  const automaticRefreshProvider = useRef<string | null>(null);
  const provider = page.kind === "overview"
    ? null
    : view.providers.find((candidate) => candidate.id === page.providerId) ?? null;
  const automaticTestModelId = provider == null ? null : view.models.find((model) =>
    model.provider_id === provider.id
      && model.enabled
      && model.model_type.value === "language"
      && model.last_test == null
  )?.id ?? null;

  useEffect(() => {
    if (page.kind !== "overview" && provider == null) {
      setCredentialDraft("");
      setCredentialMode(null);
      setCredentialTarget("config_file");
      setRevealedCredential(null);
      setFeedback({ status: "error", message: "That Provider is no longer available." });
      setPage({ kind: "overview" });
    }
  }, [page, provider]);

  useEffect(() => {
    const clearDraft = () => {
      setCredentialDraft("");
      setCredentialMode(null);
      setCredentialTarget("config_file");
      setRevealedCredential(null);
    };
    window.addEventListener("blur", clearDraft);
    return () => window.removeEventListener("blur", clearDraft);
  }, []);

  useEffect(() => {
    setRevealedCredential(null);
  }, [credentialMode]);

  useEffect(() => {
    if (credentialMode != null) draftInput.current?.focus();
  }, [credentialMode]);

  const navigate = (next: ProviderPage) => {
    const returningFromModel = page.kind === "model"
      && next.kind === "provider"
      && page.providerId === next.providerId;
    setCredentialDraft("");
    setCredentialMode(null);
    setCredentialTarget("config_file");
    setRevealedCredential(null);
    if (!returningFromModel) setDiscovery({ status: "idle" });
    if (!returningFromModel && next.kind !== "model") automaticRefreshProvider.current = null;
    setTestingModelId(null);
    setModelOptionsOpen(false);
    setConfirmingDelete(false);
    setModelMutation(null);
    if (!returningFromModel) {
      setManualAddOpen(false);
      setManualAddDraft({ modelId: "", displayName: "" });
    }
    setFeedback({ status: "idle", message: null });
    setPage(next);
  };

  // Manual ID entry opens on its own when discovery cannot list models.
  useEffect(() => {
    if (discovery.status === "complete"
        && (discovery.response.status === "unsupported" || discovery.response.status === "error")) {
      setManualAddOpen(true);
    }
  }, [discovery]);

  const refreshModels = useCallback(async (
    providerId: string,
    announce: boolean,
  ): Promise<AgentModelDiscoveryResponse | null> => {
    setDiscovery({ status: "loading" });
    try {
      const response = await transport.discoverProviderModels(providerId);
      setDiscovery({ status: "complete", response });
      if (announce) {
        setFeedback({
          status: response.status === "ready" ? "success" : "error",
          message: response.message,
        });
      }
      return response;
    } catch (error: unknown) {
      setDiscovery({
        status: "complete",
        response: {
          status: "error",
          provider_id: providerId,
          models: [],
          truncated: false,
          message: boundedMessage(error, "Models could not be refreshed."),
          error_class: "request_failed",
        },
      });
      if (announce) {
        setFeedback({ status: "error", message: boundedMessage(error, "Models could not be refreshed.") });
      }
      return null;
    }
  }, [transport]);

  useEffect(() => {
    if (page.kind !== "provider" || provider == null || provider.credential_status !== "detected") return;
    if (automaticRefreshProvider.current === provider.id) return;
    automaticRefreshProvider.current = provider.id;
    let cancelled = false;
    setDiscovery({ status: "loading" });
    void transport.discoverProviderModels(provider.id).then(async (response) => {
      if (cancelled) return;
      setDiscovery({ status: "complete", response });
      if (response.status === "ready"
          && automaticTestModelId != null) {
        setTestingModelId(automaticTestModelId);
        try {
          const next = await transport.testProviderModel({
            modelId: automaticTestModelId,
            expectedRevision: view.revision,
            expectedConfigSnapshotId: view.config_store.config_snapshot_id,
          });
          if (!cancelled) applyView(next);
        } finally {
          if (!cancelled) setTestingModelId(null);
        }
      }
    }).catch((error: unknown) => {
      if (!cancelled) {
        setDiscovery({
          status: "complete",
          response: {
            status: "error",
            provider_id: provider.id,
            models: [],
            truncated: false,
            message: boundedMessage(error, "Models could not be refreshed."),
            error_class: "request_failed",
          },
        });
      }
    });
    return () => { cancelled = true; };
  }, [
    page.kind,
    provider?.id,
    provider?.credential_status,
    automaticTestModelId,
    view.revision,
    view.config_store.config_snapshot_id,
    transport,
    applyView,
  ]);

  const testModel = async (modelId: string, announce = true) => {
    if (testingModelId != null) return null;
    setTestingModelId(modelId);
    try {
      const next = await transport.testProviderModel({
        modelId,
        expectedRevision: view.revision,
        expectedConfigSnapshotId: view.config_store.config_snapshot_id,
      });
      applyView(next);
      const result = next.models.find((model) => model.id === modelId)?.last_test ?? null;
      if (announce) {
        setFeedback({
          status: result?.status === "ready" ? "success" : "error",
          message: result?.status === "ready"
            ? `Model available · ${formatLatency(result.latency_ms)}`
            : (result?.message ?? "The model connection test failed."),
        });
      }
      return next;
    } catch (error: unknown) {
      if (announce) setFeedback({ status: "error", message: boundedMessage(error, "The model connection test failed.") });
      return null;
    } finally {
      setTestingModelId(null);
    }
  };

  const viewCredential = async (target: ProviderView) => {
    if (viewingCredential) return;
    setViewingCredential(true);
    try {
      const result = await transport.viewProviderCredential(target.id);
      if (result.outcome === "revealed" && result.credential != null) {
        setRevealedCredential({ providerId: target.id, value: result.credential });
      } else {
        setFeedback({ status: "error", message: revealOutcomeMessage(result.outcome) });
      }
    } catch (error: unknown) {
      setFeedback({
        status: "error",
        message: boundedMessage(error, "The API key could not be viewed."),
      });
    } finally {
      setViewingCredential(false);
    }
  };

  const saveCredential = async (target: ProviderView, mode: "add" | "replace") => {
    if (feedback.status === "working") return;
    if (credentialDraft.length === 0) {
      setFeedback({ status: "error", message: "Enter an API key before saving." });
      draftInput.current?.focus();
      return;
    }
    const draft = credentialDraft;
    setFeedback({ status: "working", message: mode === "replace" ? "Replacing API key…" : "Saving API key…" });
    try {
      const next = await transport.saveProviderCredential({
        providerId: target.id,
        credential: draft,
        target: credentialTarget,
        confirmReplace: mode === "replace",
        expectedRevision: view.revision,
        expectedConfigSnapshotId: view.config_store.config_snapshot_id,
      });
      setCredentialDraft("");
      setCredentialMode(null);
      setCredentialTarget("config_file");
      setRevealedCredential(null);
      applyView(next);
      const projectedProvider = next.providers.find((candidate) => candidate.id === target.id);
      const fileIsShadowed = credentialTarget === "config_file"
        && projectedProvider?.credential_effective_source === "environment";
      setFeedback({
        status: "working",
        message: fileIsShadowed
          ? "API key saved to config.yaml. The environment value remains effective; checking that value and refreshing models…"
          : "API key saved. Checking Provider and refreshing models…",
      });
      const response = await refreshModels(target.id, false);
      if (response?.status !== "ready") {
        setFeedback({
          status: "error",
          message: response?.message ?? "The API key was saved, but the Provider did not accept the validation request.",
        });
        return;
      }
      const firstModel = next.models.find((model) => model.provider_id === target.id
        && model.enabled && model.model_type.value === "language");
      if (firstModel == null) {
        setFeedback({
          status: "success",
          message: fileIsShadowed
            ? `API key saved to config.yaml · the environment value remains effective · ${response.models.length} models available.`
            : `API key verified · ${response.models.length} models available.`,
        });
        return;
      }
      const tested = await transport.testProviderModel({
        modelId: firstModel.id,
        expectedRevision: next.revision,
        expectedConfigSnapshotId: next.config_store.config_snapshot_id,
      });
      applyView(tested);
      const result = tested?.models.find((model) => model.id === firstModel.id)?.last_test ?? null;
      setFeedback(result?.status === "ready" ? {
        status: "success",
        message: fileIsShadowed
          ? `API key saved to config.yaml · the environment value remains effective · ${response.models.length} models available.`
          : `API key verified · ${formatLatency(result.latency_ms)} · ${response.models.length} models available.`,
      } : {
        status: "error",
        message: result?.message ?? "The API key was saved, but the connection test failed.",
      });
    } catch (error: unknown) {
      setCredentialDraft("");
      const failure = boundedMessage(error, "API key could not be saved.");
      try {
        applyView(await transport.loadAgentLlmSettings());
        setFeedback({ status: "error", message: `${failure} Saved settings were reloaded.`.slice(0, 320) });
      } catch (reloadError: unknown) {
        setFeedback({
          status: "error",
          message: `${failure} Refresh failed: ${boundedMessage(reloadError, "settings unavailable")}`.slice(0, 320),
        });
      }
    }
  };

  const reloadDurableTruth = async (failure: string) => {
    try {
      applyView(await transport.loadAgentLlmSettings());
      setFeedback({ status: "error", message: `${failure} Saved settings were reloaded.`.slice(0, 320) });
    } catch (reloadError: unknown) {
      setFeedback({
        status: "error",
        message: `${failure} Refresh failed: ${boundedMessage(reloadError, "settings unavailable")}`.slice(0, 320),
      });
    }
  };

  const repairConfigPermissions = async () => {
    if (feedback.status === "working" || view.config_store.config_path == null) return;
    setFeedback({ status: "working", message: "Repairing config permissions…" });
    try {
      const next = await transport.repairAgentConfigPermissions({
        expectedConfigPath: view.config_store.config_path,
        expectedRevision: view.revision,
        expectedConfigSnapshotId: view.config_store.config_snapshot_id,
      });
      applyView(next);
      setFeedback(next.config_store.permission_issues.length === 0 ? {
        status: "success",
        message: "Config permissions repaired.",
      } : {
        status: "error",
        message: "Some config permissions still need attention.",
      });
    } catch (error: unknown) {
      await reloadDurableTruth(boundedMessage(error, "Config permissions could not be repaired."));
    }
  };

  const addDiscoveredModel = async (
    target: ProviderView,
    discovered: AgentModelDiscoveryResponse["models"][number],
  ) => {
    if (modelMutation != null) return;
    setModelMutation("add");
    try {
      const next = await transport.saveModel({
        model: buildAddedModelProfile({
          providerId: target.id,
          modelId: discovered.id,
          discovered,
        }),
        expectedRevision: view.revision,
        expectedConfigSnapshotId: view.config_store.config_snapshot_id,
      });
      applyView(next);
      setFeedback({ status: "success", message: `${discovered.display_name} was added to ${target.display_name}.` });
    } catch (error: unknown) {
      await reloadDurableTruth(boundedMessage(error, "The model could not be added."));
    } finally {
      setModelMutation(null);
    }
  };

  const addManualModel = async (target: ProviderView) => {
    if (modelMutation != null) return;
    const modelId = manualAddDraft.modelId.trim();
    if (modelId === "") return;
    setModelMutation("manual");
    try {
      const next = await transport.saveModel({
        model: buildAddedModelProfile({
          providerId: target.id,
          modelId,
          displayName: manualAddDraft.displayName,
        }),
        expectedRevision: view.revision,
        expectedConfigSnapshotId: view.config_store.config_snapshot_id,
      });
      applyView(next);
      setManualAddDraft({ modelId: "", displayName: "" });
      setManualAddOpen(false);
      setFeedback({ status: "success", message: `${modelId} was added to ${target.display_name}.` });
    } catch (error: unknown) {
      await reloadDurableTruth(boundedMessage(error, "The model could not be added."));
    } finally {
      setModelMutation(null);
    }
  };

  type ConfiguredModel = AgentLlmSettingsView["models"][number];

  const deleteModel = async (target: ProviderView, model: ConfiguredModel) => {
    if (modelMutation != null) return;
    setModelMutation("delete");
    try {
      const next = await transport.deleteModel({
        modelId: model.id,
        replacementModelId: null,
        expectedRevision: view.revision,
        expectedConfigSnapshotId: view.config_store.config_snapshot_id,
      });
      applyView(next);
      navigate({ kind: "provider", providerId: target.id });
      setFeedback({ status: "success", message: `${model.display_name} was deleted.` });
    } catch (error: unknown) {
      setConfirmingDelete(false);
      await reloadDurableTruth(boundedMessage(error, "The model could not be deleted."));
    } finally {
      setModelMutation(null);
    }
  };

  const connectProvider = async () => {
    if (feedback.status === "working") return;
    const preset = PROVIDER_PRESETS[providerConnectDraft.preset];
    const baseId = providerConnectDraft.preset === "local" ? "local" : providerConnectDraft.preset;
    let providerId = baseId;
    for (let suffix = 2; view.providers.some((candidate) => candidate.id === providerId); suffix += 1) {
      providerId = `${baseId}-${suffix}`;
    }
    const configuredBaseUrl = providerConnectDraft.baseUrl.trim() || preset.defaultBaseUrl;
    if (matchesCompatibleProvider(preset.kind) && configuredBaseUrl === "") {
      setFeedback({ status: "error", message: "Enter the Provider base URL." });
      return;
    }
    if (preset.apiKeyRequired && providerConnectDraft.apiKey.trim() === "") {
      setFeedback({ status: "error", message: "Enter the Provider API key." });
      return;
    }
    const profile: AgentProviderProfile = {
      id: providerId,
      display_name: providerConnectDraft.displayName.trim() || preset.label,
      kind: preset.kind,
      registered_provider_id: preset.registeredProviderId,
      api_key_env: preset.apiKeyEnv,
      api_key_required: preset.apiKeyRequired,
      base_url: configuredBaseUrl || null,
      base_url_env: null,
      wire_api: preset.wireApi,
      disable_stream_options: null,
    };
    setFeedback({ status: "working", message: `Connecting ${profile.display_name}…` });
    try {
      let next = await transport.saveProvider({
        provider: profile,
        expectedRevision: view.revision,
        expectedConfigSnapshotId: view.config_store.config_snapshot_id,
      });
      if (preset.apiKeyRequired) {
        next = await transport.saveProviderCredential({
          providerId,
          credential: providerConnectDraft.apiKey.trim(),
          target: "session",
          confirmReplace: false,
          expectedRevision: next.revision,
          expectedConfigSnapshotId: next.config_store.config_snapshot_id,
        });
      }
      applyView(next);
      setPage({ kind: "provider", providerId });
      setProviderConnectDraft(EMPTY_PROVIDER_CONNECT);
      setProviderConnectOpen(false);
      try {
        const response = await transport.discoverProviderModels(providerId);
        setDiscovery({ status: "complete", response });
        setFeedback({
          status: response.status === "ready" ? "success" : "error",
          message: response.status === "ready"
            ? `${profile.display_name} connected · ${response.models.length} models detected automatically.`
            : response.message,
        });
      } catch (error: unknown) {
        setFeedback({ status: "error", message: boundedMessage(error, "Provider saved, but automatic model detection failed.") });
      }
    } catch (error: unknown) {
      setProviderConnectDraft((current) => ({ ...current, apiKey: "" }));
      await reloadDurableTruth(boundedMessage(error, "The Provider could not be connected."));
    }
  };

  let detailContent: ReactNode;
  if (providerConnectOpen) {
    const preset = PROVIDER_PRESETS[providerConnectDraft.preset];
    const showBaseUrl = matchesCompatibleProvider(preset.kind);
    detailContent = <form className="rho-settings-connect-provider" onSubmit={(event) => { event.preventDefault(); void connectProvider(); }}>
      <header className="rho-settings-detail-heading">
        <div><span className="rho-eyebrow">Provider setup</span><h2>Connect a model service</h2><p>Enter the essentials. Rho will create the configuration and detect available models.</p></div>
      </header>
      <label>Service<select value={providerConnectDraft.preset} onChange={(event) => {
        const nextPreset = event.target.value as ProviderPresetId;
        setProviderConnectDraft((current) => ({
          ...current,
          preset: nextPreset,
          baseUrl: PROVIDER_PRESETS[nextPreset].defaultBaseUrl,
          apiKey: "",
        }));
      }}>{Object.entries(PROVIDER_PRESETS).map(([id, definition]) => <option value={id} key={id}>{definition.label}</option>)}</select></label>
      <label>Display name (optional)<input value={providerConnectDraft.displayName} placeholder={preset.label} onChange={(event) => setProviderConnectDraft((current) => ({ ...current, displayName: event.target.value }))} /></label>
      {showBaseUrl && <label>Base URL<input type="url" required value={providerConnectDraft.baseUrl} placeholder="https://api.example.com/v1" onChange={(event) => setProviderConnectDraft((current) => ({ ...current, baseUrl: event.target.value }))} /></label>}
      {preset.apiKeyRequired && <label>API key<input type="password" required autoComplete="new-password" value={providerConnectDraft.apiKey} onChange={(event) => setProviderConnectDraft((current) => ({ ...current, apiKey: event.target.value }))} /></label>}
      <p className="rho-settings-connect-note">The API key is used for this session. Rho automatically creates config.yaml, verifies the connection, and discovers models; advanced settings remain available after setup.</p>
      <div className="rho-settings-connect-actions">
        <button type="submit" className="rho-primary-action" disabled={feedback.status === "working"}>{feedback.status === "working" ? "Connecting…" : "Connect & detect models"}</button>
        <button type="button" onClick={() => { setProviderConnectOpen(false); setProviderConnectDraft(EMPTY_PROVIDER_CONNECT); }}>Cancel</button>
      </div>
    </form>;
  } else if (provider == null || page.kind === "overview") {
    detailContent = <SurfaceTaskState
      tone="empty"
      title="Select a Provider"
      detail="Choose a Provider from the list to manage its connection, API key, and models."
      role="status"
    />;
  } else {
    const providerModels = view.models.filter((model) => model.provider_id === provider.id);
    const saved = credentialLooksSaved(provider);
    // Durable config is intentionally the safe editor default on every open.
    // Session credentials are written only after an explicit target change.
    const preferredCredentialTarget: CredentialWriteTarget = "config_file";
    const preferredTargetHasCredential = targetHasCredential(provider, preferredCredentialTarget);
    const discoveryResponse = discovery.status === "complete" ? discovery.response : null;
    const discoveredModels = discoveryResponse?.status === "ready" ? discoveryResponse.models : [];
    const discoveredIds = new Set(discoveredModels.map((model) => model.id));
    const configuredModelIds = new Set(providerModels.map((model) => model.model_id));
    const remoteOnlyModels = discoveredModels.filter((model) => !configuredModelIds.has(model.id));
    const latestModel = [...providerModels]
      .filter((model) => model.last_test != null)
      .sort((left, right) => (right.last_test?.checked_at ?? "").localeCompare(left.last_test?.checked_at ?? ""))[0];
    const latestTest = latestModel?.last_test ?? null;
    const connectionState = latestTest?.status === "ready"
      ? "Verified"
      : latestTest?.status === "error"
        ? "Needs attention"
        : discovery.status === "loading"
          ? "Checking"
          : discoveryResponse?.status === "ready"
            ? "Connected"
            : providerReadiness(provider);
    const keyState = !provider.api_key_required
      ? "Not required"
      : !saved
        ? "Missing"
        : discovery.status === "loading"
          ? "Checking"
          : discoveryResponse?.status === "ready"
            ? "Validated"
            : "Saved";

    const modelAvailability = (model: AgentLlmSettingsView["models"][number]) => {
      if (testingModelId === model.id) return "Testing…";
      if (model.last_test?.status === "ready") return "Available";
      if (model.last_test?.status === "error") return "Unavailable";
      if (discovery.status === "loading") return "Checking…";
      if (discoveredIds.has(model.model_id)) return "Available from Provider";
      if (discoveryResponse?.status === "ready") return "Not listed by Provider";
      return readable(model.selector_status);
    };

    if (page.kind === "model") {
      const configuredModel = page.remote
        ? null
        : providerModels.find((model) => model.id === page.modelId) ?? null;
      const remoteModel = page.remote
        ? discoveredModels.find((model) => model.id === page.modelId) ?? null
        : null;
      const detailName = configuredModel?.display_name ?? remoteModel?.display_name ?? page.modelId;
      const detailId = configuredModel?.model_id ?? remoteModel?.id ?? page.modelId;
      const detailType = configuredModel?.model_type ?? remoteModel?.model_type ?? null;
      const detailCapabilities = configuredModel?.capabilities ?? remoteModel?.capabilities ?? {};
      const capabilityEntries = Object.entries(detailCapabilities).sort(([left], [right]) => left.localeCompare(right));
      const lastTest = configuredModel?.last_test ?? null;
      const reportedCapacity = configuredModel != null
        && configuredModel.context_capacity_source !== "conservative_default";

      detailContent = <div className="rho-settings-provider-detail rho-settings-model-detail">
        <BackButton label={provider.display_name} onClick={() => navigate({ kind: "provider", providerId: provider.id })} />
        <header className="rho-settings-detail-heading">
          <div><span className="rho-eyebrow">{provider.display_name} · Model</span><h2>{detailName}</h2><p><code>{detailId}</code></p></div>
          <div className="rho-settings-detail-heading-actions">
            <strong>{configuredModel == null ? "Discovered" : modelAvailability(configuredModel)}</strong>
            {configuredModel != null && <button
              type="button"
              ref={editButtonRef}
              onClick={() => setModelOptionsOpen(true)}
            >Edit</button>}
          </div>
        </header>
        <section className="rho-settings-provider-block" aria-labelledby="rho-settings-model-identity-heading">
          <header><div><span className="rho-eyebrow">Model</span><h3 id="rho-settings-model-identity-heading">Identity</h3></div><span>{configuredModel == null ? "Not configured" : configuredModel.enabled ? "Enabled" : "Disabled"}</span></header>
          <dl className="rho-settings-model-facts">
            <div><dt>Model ID</dt><dd><code>{detailId}</code></dd></div>
            <div><dt>Type</dt><dd>{detailType == null ? "Unknown" : `${readable(detailType.value)} · ${evidenceSourceLabel(detailType.source)}`}</dd></div>
            {configuredModel != null && <div><dt>Preference</dt><dd>{configuredModel.selected ? "Preferred" : "Automatic"}</dd></div>}
          </dl>
        </section>
        {configuredModel != null && <section className="rho-settings-provider-block" aria-labelledby="rho-settings-model-capacity-heading">
          <header><div><span className="rho-eyebrow">Limits</span><h3 id="rho-settings-model-capacity-heading">Capacity</h3></div><span>{reportedCapacity ? readable(configuredModel.context_capacity_source) : "Not reported"}</span></header>
          {reportedCapacity ? <dl className="rho-settings-model-facts">
            <div><dt>Context window</dt><dd>{configuredModel.context_window_tokens.toLocaleString()} tokens</dd></div>
            <div><dt>Output reserve</dt><dd>{configuredModel.reserved_output_tokens.toLocaleString()} tokens</dd></div>
          </dl> : <p>The Provider did not report context or output limits. Rho does not present its internal safety fallback as model capacity.</p>}
        </section>}
        <section className="rho-settings-provider-block" aria-labelledby="rho-settings-model-test-heading">
          <header>
            <div><span className="rho-eyebrow">Connection</span><h3 id="rho-settings-model-test-heading">Latest test</h3></div>
            {configuredModel != null && <button type="button" disabled={!saved || testingModelId != null || configuredModel.model_type.value !== "language"} onClick={() => void testModel(configuredModel.id)}>Test model</button>}
          </header>
          {configuredModel == null ? <p>This model was discovered from the Provider and is not configured in Rho.</p> : lastTest == null ? <p>This model has not been connection-tested.</p> : <dl className="rho-settings-model-facts">
            <div><dt>Status</dt><dd>{readable(lastTest.status)}</dd></div>
            <div><dt>Latency</dt><dd>{formatLatency(lastTest.latency_ms)}</dd></div>
            <div><dt>Checked</dt><dd>{formatCheckedAt(lastTest.checked_at)}</dd></div>
            {lastTest.message != null && <div><dt>Result</dt><dd>{lastTest.message}</dd></div>}
          </dl>}
        </section>
        <section className="rho-settings-provider-block" aria-labelledby="rho-settings-model-capabilities-heading">
          <header><div><span className="rho-eyebrow">Model evidence</span><h3 id="rho-settings-model-capabilities-heading">Capability evidence</h3></div><span>Read only</span></header>
          {capabilityEntries.length === 0 ? <p>No capability metadata is available.</p> : <dl className="rho-settings-capability-list">
            {capabilityEntries.map(([name, capability]) => {
              const presentation = capabilityPresentation(capability);
              return <div key={name}><dt>{readable(name)}</dt><dd><strong>{presentation.value}</strong><small>{presentation.source}</small></dd></div>;
            })}
          </dl>}
        </section>
        {configuredModel != null && <section className="rho-settings-provider-block rho-settings-danger-zone" aria-labelledby="rho-settings-model-delete-heading">
          <header><div><span className="rho-eyebrow">Danger</span><h3 id="rho-settings-model-delete-heading">Delete this model</h3></div></header>
          {confirmingDelete ? <>
            <p role="alert">Delete {configuredModel.display_name}? This cannot be undone.</p>
            <div className="rho-settings-danger-actions">
              <button
                type="button"
                disabled={modelMutation != null}
                onClick={() => void deleteModel(provider, configuredModel)}
              >{modelMutation === "delete" ? "Deleting…" : "Confirm delete"}</button>
              <button type="button" onClick={() => setConfirmingDelete(false)}>Cancel</button>
            </div>
          </> : <>
            <p>Deleting removes this model from Rho. Models assigned to capability routes cannot be deleted.</p>
            <div className="rho-settings-danger-actions">
              <button type="button" disabled={modelMutation != null} onClick={() => setConfirmingDelete(true)}>Delete this model</button>
            </div>
          </>}
        </section>}
        {modelOptionsOpen && configuredModel != null && <ModelOptionsDialog
          model={configuredModel}
          revision={view.revision}
          configSnapshotId={view.config_store.config_snapshot_id}
          transport={transport}
          applyView={applyView}
          onFeedback={setFeedback}
          onClose={() => {
            setModelOptionsOpen(false);
            editButtonRef.current?.focus();
          }}
        />}
      </div>;
    } else {
      detailContent = <div className="rho-settings-provider-detail">
        <header className="rho-settings-detail-heading">
          <div><span className="rho-eyebrow">Provider</span><h2>{provider.display_name}</h2><p>{provider.kind}</p></div>
          <strong>{providerReadiness(provider)}</strong>
        </header>
        <section className="rho-settings-provider-health" aria-label="Provider health">
          <div><span>Connection</span><strong>{connectionState}</strong><small>{latestTest == null ? "Not tested yet" : `Checked ${formatCheckedAt(latestTest.checked_at)}`}</small></div>
          <div><span>Latency</span><strong>{formatLatency(latestTest?.latency_ms ?? null)}</strong><small>{latestModel?.display_name ?? "Run a model test"}</small></div>
          <div><span>Models</span><strong>{providerModels.length} configured</strong><small>Availability refreshes when this Provider opens</small></div>
        </section>
        <section className="rho-settings-provider-block" aria-labelledby="rho-settings-endpoint-heading">
          <header><div><span className="rho-eyebrow">Connection</span><h3 id="rho-settings-endpoint-heading">Endpoint</h3></div><span>{readable(provider.base_url_source)}</span></header>
          <dl className="rho-settings-endpoint-facts">
            <div><dt>Base URL</dt><dd><code>{provider.effective_base_url ?? "Not configured"}</code></dd></div>
            <div><dt>API format</dt><dd>{provider.wire_api == null ? "Provider default" : readable(provider.wire_api)}</dd></div>
          </dl>
        </section>
        <section className="rho-settings-provider-block" aria-labelledby="rho-settings-credential-heading">
          <header><div><span className="rho-eyebrow">Authentication</span><h3 id="rho-settings-credential-heading">API key</h3></div><span>{keyState}</span></header>
          {!provider.api_key_required ? <p>API key not required.</p> : credentialMode != null ? (
            <form className="rho-settings-inline-credential" onSubmit={(event) => { event.preventDefault(); void saveCredential(provider, credentialMode); }}>
              <label htmlFor="rho-settings-api-key">{credentialMode === "replace" ? "Replacement API key" : "API key"}</label>
              <div>
                <input
                  ref={draftInput}
                  id="rho-settings-api-key"
                  type="password"
                  autoComplete="new-password"
                  value={credentialDraft}
                  disabled={feedback.status === "working"}
                  onChange={(event) => setCredentialDraft(event.target.value)}
                />
                <button type="submit" disabled={feedback.status === "working"}>{feedback.status === "working" ? "Checking…" : "Save & verify"}</button>
                <button type="button" onClick={() => { setCredentialDraft(""); setCredentialMode(null); setCredentialTarget("config_file"); }}>Cancel</button>
              </div>
              <label htmlFor="rho-settings-credential-target">Save target</label>
              <select
                id="rho-settings-credential-target"
                value={credentialTarget}
                disabled={feedback.status === "working"}
                onChange={(event) => {
                  const nextTarget = event.target.value as CredentialWriteTarget;
                  setCredentialTarget(nextTarget);
                  setCredentialMode(targetHasCredential(provider, nextTarget) ? "replace" : "add");
                }}
              >
                <option value="config_file">config.yaml (plaintext)</option>
                <option value="session">This session only</option>
              </select>
              <small>{credentialTarget === "session"
                ? "This value stays in memory until Rho exits and is never written to disk."
                : `This value is written in plaintext to ${view.config_store.config_path ?? "config.yaml"}. Saving immediately checks the effective credential and refreshes models.`}</small>
            </form>
          ) : saved ? <>
            <div className="rho-settings-secret-row">
              {revealedCredential?.providerId === provider.id ? (
                <div className="rho-settings-secret-mask rho-settings-secret-revealed" aria-label="Saved API key">{revealedCredential.value}</div>
              ) : (
                <div className="rho-settings-secret-mask" aria-label="Saved API key, hidden">{FIXED_CREDENTIAL_MASK}</div>
              )}
              {revealedCredential?.providerId === provider.id ? (
                <button type="button" disabled={viewingCredential} onClick={() => setRevealedCredential(null)}>Hide</button>
              ) : (
                <button type="button" disabled={viewingCredential || feedback.status === "working" || testingModelId != null} onClick={() => void viewCredential(provider)}>View</button>
              )}
              <button type="button" disabled={feedback.status === "working" || testingModelId != null} onClick={() => {
                setRevealedCredential(null);
                setCredentialTarget(preferredCredentialTarget);
                setCredentialMode(preferredTargetHasCredential ? "replace" : "add");
              }}>{preferredTargetHasCredential ? "Replace" : "Add API key"}</button>
            </div>
            <small>{credentialSourceLabel(provider)} is effective.{provider.env_shadows_file
              ? " The environment value shadows the API key saved in config.yaml."
              : ""}</small>
          </> : <div className="rho-settings-missing-credential">
            <p>Add an API key to connect, validate it, and load this Provider's models.</p>
            <button type="button" onClick={() => {
              setCredentialTarget("config_file");
              setCredentialMode(provider.config_file_credential_present ? "replace" : "add");
            }}>Add API key</button>
          </div>}
        </section>
        <section className="rho-settings-section rho-settings-provider-model-section" aria-labelledby="rho-settings-models-heading">
          <div>
            <h3 id="rho-settings-models-heading">Models</h3>
            <button type="button" disabled={!saved || discovery.status === "loading"} onClick={() => void refreshModels(provider.id, true)}>{discovery.status === "loading" ? "Refreshing…" : "Refresh models"}</button>
          </div>
          {discoveryResponse != null && <p className={`rho-settings-discovery rho-settings-discovery-${discoveryResponse.status}`}>{discoveryResponse.message}</p>}
          {providerModels.length === 0 && remoteOnlyModels.length === 0 ? <p className="rho-settings-empty">No models are available from this Provider.</p> : (
            <div className="rho-settings-model-list">
              {providerModels.map((model) => <article key={model.id}>
                <div><strong>{model.display_name}</strong><code>{model.model_id}</code><small>{model.last_test == null ? "Not connection-tested" : `${formatLatency(model.last_test.latency_ms)} · ${formatCheckedAt(model.last_test.checked_at)}`}</small></div>
                <div className="rho-settings-model-actions">
                  <strong>{modelAvailability(model)}</strong>
                  <div>
                    <button type="button" onClick={() => navigate({ kind: "model", providerId: provider.id, modelId: model.id, remote: false })}>Details</button>
                    <button type="button" disabled={!saved || testingModelId != null || model.model_type.value !== "language"} onClick={() => void testModel(model.id)}>Test</button>
                  </div>
                </div>
              </article>)}
              {remoteOnlyModels.map((model) => {
                const alreadyAdded = view.models.some((candidate) => candidate.id === `model-${model.id}`);
                return <article key={`remote:${model.id}`} className="rho-settings-model-remote">
                  <div><strong>{model.display_name}</strong><code>{model.id}</code><small>Discovered automatically</small></div>
                  <div className="rho-settings-model-actions">
                    <strong>Available from Provider</strong>
                    <div>
                      <button type="button" onClick={() => navigate({ kind: "model", providerId: provider.id, modelId: model.id, remote: true })}>Details</button>
                      {!alreadyAdded && <button
                        type="button"
                        disabled={modelMutation != null}
                        onClick={() => void addDiscoveredModel(provider, model)}
                      >{modelMutation === "add" ? "Adding…" : "Add"}</button>}
                    </div>
                  </div>
                </article>;
              })}
            </div>
          )}
          {(() => {
            const manualModelId = manualAddDraft.modelId.trim();
            const duplicate = manualModelId !== ""
              && providerModels.some((model) => model.model_id === manualModelId);
            return <div className="rho-settings-manual-add">
              <button
                type="button"
                aria-expanded={manualAddOpen}
                onClick={() => setManualAddOpen((open) => !open)}
              >Enter a model ID manually</button>
              {manualAddOpen && <form
                className="rho-settings-inline-credential"
                onSubmit={(event) => { event.preventDefault(); void addManualModel(provider); }}
              >
                <label htmlFor="rho-settings-manual-model-id">Model ID</label>
                <div>
                  <input
                    id="rho-settings-manual-model-id"
                    type="text"
                    required
                    value={manualAddDraft.modelId}
                    disabled={modelMutation != null}
                    onChange={(event) => setManualAddDraft((draft) => ({ ...draft, modelId: event.target.value }))}
                  />
                </div>
                <label htmlFor="rho-settings-manual-model-name">Display name (optional)</label>
                <div>
                  <input
                    id="rho-settings-manual-model-name"
                    type="text"
                    placeholder={manualModelId}
                    value={manualAddDraft.displayName}
                    disabled={modelMutation != null}
                    onChange={(event) => setManualAddDraft((draft) => ({ ...draft, displayName: event.target.value }))}
                  />
                </div>
                {duplicate && <p role="alert">This model ID is already configured for this Provider.</p>}
                <div>
                  <button
                    type="submit"
                    disabled={modelMutation != null || manualModelId === "" || duplicate}
                  >{modelMutation === "manual" ? "Adding…" : "Add"}</button>
                  <button
                    type="button"
                    onClick={() => {
                      setManualAddDraft({ modelId: "", displayName: "" });
                      setManualAddOpen(false);
                    }}
                  >Cancel</button>
                </div>
                <small>Manually added models start with unknown capabilities until a connection test or declaration records evidence.</small>
              </form>}
            </div>;
          })()}
        </section>
      </div>;
    }
  }

  return <div className="rho-settings-providers">
    <div className="rho-settings-providers-list">
      <header className="rho-settings-module-heading">
        <div><span className="rho-eyebrow">Settings</span><h2>Providers</h2></div>
        <div className="rho-settings-module-heading-actions">
          <button type="button" className="rho-primary-action" onClick={() => { setProviderConnectOpen(true); setPage({ kind: "overview" }); }}>+ Provider</button>
          <button type="button" onClick={refresh}>Refresh</button>
        </div>
      </header>
      <details className={`rho-settings-config-store rho-settings-config-store-${view.config_store.status}`} aria-label="Rho model configuration" open={view.config_store.permission_issues.length > 0 || undefined}>
        <summary><strong>Configuration storage</strong><span>{configStoreStatusLabel(view.config_store.status)}</span></summary>
        <code>{view.config_store.config_path ?? "Path unavailable"}</code>
        <p>{configStoreDetail(view.config_store)}</p>
        {view.config_store.permission_issues.length > 0 && <div className="rho-settings-config-permissions" role="alert">
          <strong>Loose permissions detected</strong>
          <ul>{view.config_store.permission_issues.map((issue) => <li key={`${issue.subject}:${issue.path}`}>
            <code>{issue.path}</code> is {permissionMode(issue.actual_mode)}; expected {permissionMode(issue.expected_mode)}.
          </li>)}</ul>
          <button
            type="button"
            disabled={feedback.status === "working" || view.config_store.config_path == null}
            onClick={() => void repairConfigPermissions()}
          >Repair permissions</button>
        </div>}
      </details>
      {view.providers.length === 0 ? (
        <SurfaceTaskState
          tone={view.config_store.status === "malformed" || view.config_store.status === "unsupported_schema_version" ? "attention" : "empty"}
          title="No Providers"
          detail="Connect a service with only its name and API key. Rho creates configuration and detects models automatically."
          role="status"
        ><button type="button" className="rho-primary-action" onClick={() => setProviderConnectOpen(true)}>Connect Provider</button></SurfaceTaskState>
      ) : <div className="rho-settings-row-list" aria-label="Configured Providers">
        {view.providers.map((item) => {
          const modelCount = view.models.filter((model) => model.provider_id === item.id).length;
          const selected = page.kind !== "overview" && page.providerId === item.id;
          return <button
            type="button"
            className="rho-settings-row"
            key={item.id}
            aria-current={selected || undefined}
            onClick={() => navigate({ kind: "provider", providerId: item.id })}
          >
            <span><strong>{item.display_name}</strong><small>{item.kind}</small></span>
            <span><strong>{providerReadiness(item)}</strong><small>{modelCount} model{modelCount === 1 ? "" : "s"}</small></span>
            <span aria-hidden="true">›</span>
          </button>;
        })}
      </div>}
    </div>
    <section className="rho-settings-providers-detail" aria-label="Provider details">
      <FeedbackBanner feedback={feedback} />
      {view.validation_error != null && (
        <p className="rho-settings-notice rho-settings-notice-error" role="alert">{view.validation_error}</p>
      )}
      {detailContent}
    </section>
  </div>;
}

function ComponentsSettingsModule({ factories }: { readonly factories: readonly SurfaceFactoryRegistration[] }) {
  const groups = useMemo(() => {
    const application = factories.filter((factory) =>
      factory.definition.origin.kind === "application"
      && surfaceCatalogPolicy(factory.definition.surface_id).capabilityGroup !== "developer");
    return {
      capabilities: Object.entries(SURFACE_CAPABILITY_GROUPS).map(([groupId, definition]) => ({
        groupId,
        definition,
        factories: application.filter((factory) =>
          surfaceCatalogPolicy(factory.definition.surface_id).capabilityGroup === groupId)
          .sort((left, right) => compareSurfaceCatalogOrder(
            left.definition.surface_id,
            right.definition.surface_id,
          )),
      })),
      project: factories.filter((factory) => factory.definition.origin.kind === "workspace_plugin"),
    };
  }, [factories]);
  return <div className="rho-settings-module rho-settings-components">
    <header className="rho-settings-module-heading"><div><span className="rho-eyebrow">Capabilities</span><h2>Built-in capabilities</h2></div></header>
    <p className="rho-settings-intro">Rho groups its stable workbench components by user task. Only installed project packages are treated as plugins.</p>
    <section className="rho-settings-section">
      <div className="rho-settings-section-heading"><div><h3>Rho application</h3><p>{groups.capabilities.length} stable capability groups</p></div></div>
      <div className="rho-settings-component-list">
        {groups.capabilities.map(({ groupId, definition, factories: items }) => {
          const primaryCount = items.filter((factory) =>
            surfaceCatalogPolicy(factory.definition.surface_id).visibility === "primary").length;
          return <article data-capability-group={groupId} key={groupId}>
            <div><strong>{definition.label}</strong><small>{items.map((factory) => surfaceDisplayLabel(factory.definition.surface_id)).join(" · ") || "No registered views"}</small></div>
            <p>{definition.description}</p>
            <dl>
              <div><dt>Views</dt><dd>{items.length}</dd></div>
              <div><dt>Compose</dt><dd>{primaryCount}</dd></div>
              <div><dt>Origin</dt><dd>Rho application</dd></div>
            </dl>
          </article>;
        })}
      </div>
    </section>
    <section className="rho-settings-section">
      <div className="rho-settings-section-heading"><div><h3>Project extensions</h3><p>{groups.project.length} installed Surface contribution{groups.project.length === 1 ? "" : "s"}</p></div></div>
      {groups.project.length === 0 ? <p className="rho-settings-empty">No project extensions are installed.</p> : <div className="rho-settings-component-list">
        {[...groups.project].sort((left, right) => left.definition.label.localeCompare(right.definition.label)).map((factory) => {
          const origin = factory.definition.origin;
          return <article key={`${factory.definition.surface_id}:${factory.activation_generation}`}>
            <div><strong>{factory.definition.label}</strong><code>{factory.definition.surface_id}</code></div>
            <p>{factory.definition.purpose}</p>
            <dl>
              <div><dt>Scope</dt><dd>{factory.definition.scope}</dd></div>
              <div><dt>Instances</dt><dd>{readable(factory.definition.instance_policy)}</dd></div>
              <div><dt>Plugin</dt><dd>{origin.kind === "workspace_plugin" ? origin.plugin_id : "Rho application"}</dd></div>
            </dl>
          </article>;
        })}
      </div>}
    </section>
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
  const generation = useRef(0);

  const reload = useCallback(() => {
    const current = generation.current + 1;
    generation.current = current;
    setSettingsState({ status: "loading" });
    void transport.loadAgentLlmSettings().then((view) => {
      if (generation.current === current) setSettingsState({ status: "ready", view });
    }).catch((error: unknown) => {
      if (generation.current === current) {
        setSettingsState({ status: "failed", message: boundedMessage(error, "Provider settings could not be read.") });
      }
    });
  }, [transport]);

  useEffect(() => {
    reload();
    return () => { generation.current += 1; };
  }, [reload]);

  let providerContent;
  if (settingsState.status === "loading") {
    providerContent = <div className="rho-settings-module"><SurfaceTaskState tone="loading" title="Loading Providers" detail="Reading presentation-safe Provider settings." role="status" busy /></div>;
  } else if (settingsState.status === "failed") {
    providerContent = <div className="rho-settings-module"><SurfaceTaskState tone="error" title="Providers unavailable" detail={settingsState.message} role="alert"><button type="button" onClick={reload}>Retry</button></SurfaceTaskState></div>;
  } else {
    providerContent = <ProvidersSettingsModule
      view={settingsState.view}
      transport={transport}
      applyView={(view) => setSettingsState({ status: "ready", view })}
      refresh={reload}
    />;
  }

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
      {activeModule === "providers" ? providerContent : <ComponentsSettingsModule factories={factories} />}
    </section>
  </div>;
}
