import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  AgentLlmCredentialRevealView,
  AgentLlmSettingsView,
  SurfaceInstance,
} from "../transport";
import { createMockUiKernelTransport } from "../transport/mock";
import {
  SettingsSurfaceView,
  settingsModuleFromViewState,
} from "./SettingsSurfaceView";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

async function settle() {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
}

function button(container: HTMLElement, label: string): HTMLButtonElement {
  const match = [...container.querySelectorAll<HTMLButtonElement>("button")]
    .find((candidate) => candidate.textContent?.trim() === label || candidate.textContent?.includes(label));
  if (match == null) throw new Error(`Missing button: ${label}`);
  return match;
}

async function click(target: HTMLButtonElement) {
  await act(async () => {
    target.click();
    await settle();
  });
}

async function inputValue(target: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(target, value);
    target.dispatchEvent(new Event("input", { bubbles: true }));
    await settle();
  });
}

async function selectValue(target: HTMLSelectElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(target, value);
    target.dispatchEvent(new Event("change", { bubbles: true }));
    await settle();
  });
}

describe("Provider-first Settings Surface", () => {
  const roots: Array<ReturnType<typeof createRoot>> = [];

  afterEach(() => {
    for (const root of roots.splice(0)) act(() => root.unmount());
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  async function renderSettings(options: {
    readonly transport?: ReturnType<typeof createMockUiKernelTransport>;
    readonly viewState?: unknown;
  } = {}) {
    const transport = options.transport ?? createMockUiKernelTransport("plugin=surface");
    const surfaces = await transport.loadSurfaces();
    const instance: SurfaceInstance = {
      instance_id: "surface-instance:settings-test",
      surface_id: "rho.settings",
      project_id: surfaces.project_id,
      origin: { kind: "application", component_id: "rho.settings" },
      activation_generation: 1,
      surface_revision: 1,
      mode_id: "settings",
      resource_binding: null,
      runtime_binding: null,
      view_group_id: null,
      view_state: options.viewState ?? {},
      lifecycle_state: "active",
    };
    const persist = vi.fn(async () => undefined);
    const reportError = vi.fn();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => {
      root.render(<SettingsSurfaceView
        instance={instance}
        transport={transport}
        factories={surfaces.catalog.factories}
        persist={persist}
        reportError={reportError}
      />);
      await settle();
    });
    return { container, persist, reportError, root, transport, instance };
  }

  async function openProvider(container: HTMLElement) {
    await click(button(container, "Mock Provider"));
    expect(container.textContent).toContain("Endpoint");
    expect(container.textContent).toContain("API key");
    expect(container.textContent).toContain("Models");
  }

  it("uses Providers as the default and legacy fallback with only Capabilities beside it", async () => {
    expect(settingsModuleFromViewState({ module_id: "components" })).toBe("components");
    expect(settingsModuleFromViewState({ module_id: "providers" })).toBe("providers");
    expect(settingsModuleFromViewState({ module_id: "models" })).toBe("providers");
    expect(settingsModuleFromViewState({ module_id: "workspace-secret" })).toBe("providers");
    expect(settingsModuleFromViewState(null)).toBe("providers");

    const { container } = await renderSettings({ viewState: { module_id: "models" } });
    expect([...container.querySelectorAll("[role='tab']")].map((tab) => tab.textContent)).toEqual([
      "ProvidersConnect services Rho can use.",
      "CapabilitiesInspect built-in capabilities and project extensions.",
    ]);
    expect(container.textContent).toContain("Providers");
    expect(container.textContent).not.toContain("Capability routes");
    expect(container.textContent).not.toContain("Use for Chat");
    expect(container.querySelector("input[type='password']")).toBeNull();
  });

  it("keeps storage implementation secondary without exposing its snapshot token", async () => {
    const { container } = await renderSettings();
    expect(container.textContent).toContain("Configuration storage");
    expect(container.textContent).toContain("/mock/home/.rho/config.yaml");
    expect(container.textContent).not.toContain("API keys saved to this file are readable");
    expect(container.textContent).not.toContain("mock-config-snapshot-1");
  });

  it("keeps missing and malformed config states inside the truthful empty Settings view", async () => {
    for (const state of [
      { status: "missing" as const, detail: null },
      { status: "malformed" as const, detail: "the file is not valid V6 YAML (line 3, column 2)" },
    ]) {
      const transport = createMockUiKernelTransport();
      const base = await transport.loadAgentLlmSettings();
      transport.loadAgentLlmSettings = vi.fn(async () => ({
        ...base,
        providers: [],
        models: [],
        config_store: { ...base.config_store, ...state },
      }));
      const { container } = await renderSettings({ transport });
      expect(container.textContent).toContain("No Providers");
      expect(container.textContent).toContain("/mock/home/.rho/config.yaml");
      expect(container.textContent).not.toContain("Providers unavailable");
      if (state.detail != null) expect(container.textContent).toContain(state.detail);
    }
  });

  it("connects a Provider from essential fields and detects models automatically", async () => {
    const transport = createMockUiKernelTransport();
    const base = await transport.loadAgentLlmSettings();
    const empty: AgentLlmSettingsView = {
      ...base,
      providers: [],
      models: [],
      config_store: { ...base.config_store, status: "missing" },
    };
    transport.loadAgentLlmSettings = vi.fn(async () => structuredClone(empty));
    transport.saveProvider = vi.fn(async (request) => ({
      ...empty,
      revision: 1,
      config_store: { ...empty.config_store, status: "loaded", config_snapshot_id: "provider-saved" },
      providers: [{
        ...request.provider,
        credential_status: "not_checked",
        credential_effective_source: "not_configured",
        env_shadows_file: false,
        session_credential_present: false,
        config_file_credential_present: false,
        effective_base_url: "https://api.deepseek.com",
        base_url_source: "provider_default",
      }],
    }));
    transport.saveProviderCredential = vi.fn(async () => ({
      ...await transport.saveProvider({
        provider: {
          id: "deepseek", display_name: "DeepSeek", kind: "registered", registered_provider_id: "deepseek",
          api_key_env: "DEEPSEEK_API_KEY", api_key_required: true, base_url: null, base_url_env: null,
          wire_api: null, disable_stream_options: null,
        },
        expectedRevision: 0,
        expectedConfigSnapshotId: "mock",
      }),
      revision: 1,
      config_store: { ...empty.config_store, status: "loaded", config_snapshot_id: "credential-saved" },
      providers: [{
        id: "deepseek", display_name: "DeepSeek", kind: "registered", registered_provider_id: "deepseek",
        api_key_env: "DEEPSEEK_API_KEY", api_key_required: true, base_url: null, base_url_env: null,
        wire_api: null, disable_stream_options: null, credential_status: "detected",
        credential_effective_source: "session", env_shadows_file: false,
        session_credential_present: true, config_file_credential_present: false,
        effective_base_url: "https://api.deepseek.com", base_url_source: "provider_default",
      }],
    }));
    transport.discoverProviderModels = vi.fn(async () => ({
      status: "ready", provider_id: "deepseek", models: [{
        id: "deepseek-chat", display_name: "DeepSeek Chat",
        model_type: { value: "language", source: "provider_response" }, capabilities: {},
      }], truncated: false, message: "Loaded models.", error_class: null,
    }));
    const { container } = await renderSettings({ transport });
    expect(container.textContent).toContain("Rho will create the configuration automatically");
    await click(button(container, "Connect Provider"));
    const select = container.querySelector<HTMLSelectElement>(".rho-settings-connect-provider select")!;
    await act(async () => {
      select.value = "deepseek";
      select.dispatchEvent(new Event("change", { bubbles: true }));
      await settle();
    });
    const keyInput = container.querySelector<HTMLInputElement>(".rho-settings-connect-provider input[type='password']")!;
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      setValue.call(keyInput, "session-secret");
      keyInput.dispatchEvent(new Event("input", { bubbles: true }));
      await settle();
    });
    await click(button(container, "Connect & detect models"));
    expect(transport.saveProvider).toHaveBeenCalledWith(expect.objectContaining({
      provider: expect.objectContaining({ kind: "registered", registered_provider_id: "deepseek" }),
    }));
    expect(transport.saveProviderCredential).toHaveBeenCalledWith(expect.objectContaining({
      providerId: "deepseek", target: "session", credential: "session-secret",
    }));
    expect(transport.discoverProviderModels).toHaveBeenCalledWith("deepseek");
    expect(container.textContent).toContain("1 models detected automatically");
    expect(container.textContent).toContain("DeepSeek");
  });

  it("repairs only the projected config path and reloads the returned permission truth", async () => {
    const transport = createMockUiKernelTransport();
    const base = await transport.loadAgentLlmSettings();
    const current: AgentLlmSettingsView = {
      ...base,
      config_store: {
        ...base.config_store,
        permission_issues: [{
          subject: "config_file",
          path: base.config_store.config_path!,
          actual_mode: 0o644,
          expected_mode: 0o600,
        }],
      },
    };
    transport.loadAgentLlmSettings = vi.fn(async () => structuredClone(current));
    transport.repairAgentConfigPermissions = vi.fn(async () => ({
      ...current,
      config_store: { ...current.config_store, permission_issues: [] },
    }));

    const { container } = await renderSettings({ transport });
    expect(container.textContent).toContain("0644; expected 0600");
    await click(button(container, "Repair permissions"));
    expect(transport.repairAgentConfigPermissions).toHaveBeenCalledWith({
      expectedConfigPath: base.config_store.config_path,
      expectedRevision: base.revision,
      expectedConfigSnapshotId: base.config_store.config_snapshot_id,
    });
    expect(container.textContent).toContain("Config permissions repaired.");
    expect(container.textContent).not.toContain("0644; expected 0600");
  });

  it("keeps the Provider list visible beside connection, API key, and inline models", async () => {
    const { container } = await renderSettings();
    expect(container.textContent).toContain("Mock Provider");
    expect(container.textContent).toContain("Select a Provider");
    expect(container.textContent).not.toContain("mock-model");

    await openProvider(container);
    expect(container.textContent).toContain("https://example.invalid/v1");
    expect(container.textContent).toContain("Connection");
    expect(container.textContent).toContain("Latency");
    expect(container.textContent).toContain("View");
    expect(container.textContent).not.toContain("Select a Provider");
    expect(container.textContent).toContain("mock-model");
    expect(container.textContent).toContain("Available");
    expect(container.textContent).toContain("Details");
    expect(container.textContent).not.toContain("New API key");
    expect(container.textContent).not.toContain("Capability routes");
    expect([...container.querySelectorAll<HTMLButtonElement>(".rho-settings-row")]).toHaveLength(1);
    expect(container.querySelector(".rho-settings-row")?.getAttribute("aria-current")).toBe("true");
  });

  it("shows the resolved Provider default, latest latency, availability, and refreshes models", async () => {
    const transport = createMockUiKernelTransport();
    const base = await transport.loadAgentLlmSettings();
    const current: AgentLlmSettingsView = {
      ...base,
      providers: base.providers.map((provider) => ({
        ...provider,
        kind: "registered",
        registered_provider_id: "deepseek",
        base_url: null,
        effective_base_url: "https://api.deepseek.com",
        base_url_source: "provider_default",
      })),
      models: base.models.map((model) => ({
        ...model,
        last_test: {
          status: "ready",
          checked_at: "2026-08-26T12:00:00Z",
          latency_ms: 86,
          error_class: null,
          message: "Connection ready.",
        },
      })),
    };
    transport.loadAgentLlmSettings = vi.fn(async () => structuredClone(current));
    transport.discoverProviderModels = vi.fn(async (providerId) => ({
      status: "ready",
      provider_id: providerId,
      models: [{
        id: "mock-model",
        display_name: "Mock model",
        model_type: { value: "language", source: "catalog" },
        capabilities: {},
      }],
      truncated: false,
      message: "Loaded 1 available model.",
      error_class: null,
    }));

    const { container } = await renderSettings({ transport });
    await openProvider(container);
    expect(container.textContent).toContain("https://api.deepseek.com");
    expect(container.textContent).toContain("provider default");
    expect(container.textContent).toContain("86 ms");
    expect(container.textContent).toContain("Available");
    expect(transport.discoverProviderModels).toHaveBeenCalledWith("mock-provider");
    expect(transport.discoverProviderModels).toHaveBeenCalledTimes(1);
    await click(button(container, "Refresh models"));
    expect(transport.discoverProviderModels).toHaveBeenCalledTimes(2);
  });

  it("goes directly to Add API key without an intermediate credential-store screen", async () => {
    const transport = createMockUiKernelTransport();
    const base = await transport.loadAgentLlmSettings();
    const current: AgentLlmSettingsView = {
      ...base,
      providers: base.providers.map((provider) => ({
        ...provider,
        credential_status: "not_detected",
        credential_effective_source: "not_configured",
        config_file_credential_present: false,
      })),
    };
    transport.loadAgentLlmSettings = vi.fn(async () => structuredClone(current));

    const { container } = await renderSettings({ transport });
    await openProvider(container);
    expect(container.textContent).toContain("Add API key");
    expect(container.textContent).toContain("Models");
    expect(container.textContent).not.toContain("Rho Vault");
    expect(container.textContent).not.toContain("Unlock");
    expect(container.querySelector("input[type='password']")).toBeNull();
    await click(button(container, "Add API key"));
    expect(container.querySelector("input[type='password']")).not.toBeNull();
    expect(container.textContent).toContain("Save & verify");
    expect(container.textContent).toContain("Models");
  });

  it("reveals the saved API key inline on View and restores the fixed mask on Hide", async () => {
    const transport = createMockUiKernelTransport();
    transport.viewProviderCredential = vi.fn(transport.viewProviderCredential);
    const { container } = await renderSettings({ transport });
    await openProvider(container);

    expect(container.querySelector(".rho-settings-secret-mask")?.textContent).toBe("••••••••••••••••");
    expect(container.textContent).toContain("View");
    expect(container.textContent).toContain("Replace");
    expect(container.textContent).not.toContain("mock-config_file-api-key");

    await click(button(container, "View"));
    expect(transport.viewProviderCredential).toHaveBeenCalledTimes(1);
    expect(transport.viewProviderCredential).toHaveBeenCalledWith("mock-provider");
    expect(container.querySelector(".rho-settings-secret-mask")?.textContent).toBe("mock-config_file-api-key");
    expect(container.textContent).toContain("Hide");
    expect(container.textContent).not.toContain("••••••••••••••••");
    expect(container.querySelector("input")).toBeNull();

    await click(button(container, "Hide"));
    expect(container.querySelector(".rho-settings-secret-mask")?.textContent).toBe("••••••••••••••••");
    expect(container.textContent).not.toContain("mock-config_file-api-key");
    expect(container.textContent).toContain("View");
  });

  it("keeps the fixed mask and disables View while a single view request is pending", async () => {
    const transport = createMockUiKernelTransport();
    let resolveReveal: ((value: AgentLlmCredentialRevealView) => void) | null = null;
    transport.viewProviderCredential = vi.fn(() => new Promise<AgentLlmCredentialRevealView>((resolve) => {
      resolveReveal = resolve;
    }));
    const { container } = await renderSettings({ transport });
    await openProvider(container);

    await click(button(container, "View"));
    expect(button(container, "View").disabled).toBe(true);
    expect(container.querySelector(".rho-settings-secret-mask")?.textContent).toBe("••••••••••••••••");
    expect(transport.viewProviderCredential).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveReveal?.({
        outcome: "revealed",
        credential: "mock-config_file-api-key",
        source: "config_file",
        env_shadows_file: false,
      });
      await settle();
    });
    expect(container.querySelector(".rho-settings-secret-mask")?.textContent).toBe("mock-config_file-api-key");
    expect(button(container, "Hide").disabled).toBe(false);
  });

  it("clears a revealed API key on navigation, window blur, and entering Replace", async () => {
    const transport = createMockUiKernelTransport();
    const { container } = await renderSettings({ transport });
    await openProvider(container);

    await click(button(container, "View"));
    expect(container.textContent).toContain("mock-config_file-api-key");
    await click(button(container, "Details"));
    expect(container.textContent).not.toContain("mock-config_file-api-key");
    await click(container.querySelector<HTMLButtonElement>(".rho-settings-back")!);
    expect(container.querySelector(".rho-settings-secret-mask")?.textContent).toBe("••••••••••••••••");

    await click(button(container, "View"));
    expect(container.textContent).toContain("mock-config_file-api-key");
    await act(async () => {
      window.dispatchEvent(new Event("blur"));
      await settle();
    });
    expect(container.querySelector(".rho-settings-secret-mask")?.textContent).toBe("••••••••••••••••");
    expect(container.textContent).not.toContain("mock-config_file-api-key");

    await click(button(container, "View"));
    expect(container.textContent).toContain("mock-config_file-api-key");
    await click(button(container, "Replace"));
    expect(container.textContent).not.toContain("mock-config_file-api-key");
    expect(container.querySelector("input[type='password']")).not.toBeNull();
  });

  it("maps View failure outcomes to truthful banners without revealing a value", async () => {
    const transport = createMockUiKernelTransport();
    const { container } = await renderSettings({ transport });
    await openProvider(container);

    transport.viewProviderCredential = vi.fn(async () => ({
      outcome: "credential_missing" as const,
      credential: null,
      source: null,
      env_shadows_file: false,
    }));
    await click(button(container, "View"));
    expect(container.textContent).toContain("No saved API key was found. Add it again.");
    expect(container.querySelector(".rho-settings-secret-mask")?.textContent).toBe("••••••••••••••••");

    transport.viewProviderCredential = vi.fn(async () => ({
      outcome: "credential_unavailable" as const,
      credential: null,
      source: null,
      env_shadows_file: false,
    }));
    await click(button(container, "View"));
    expect(container.textContent).toContain("The effective API key could not be read.");
    expect(container.querySelector(".rho-settings-secret-mask")?.textContent).toBe("••••••••••••••••");
    expect(container.querySelector("input")).toBeNull();
  });

  it("refreshes once on Provider entry and exposes each model's read-only detail page", async () => {
    const transport = createMockUiKernelTransport();
    const discover = transport.discoverProviderModels.bind(transport);
    const test = transport.testProviderModel.bind(transport);
    transport.discoverProviderModels = vi.fn(discover);
    transport.testProviderModel = vi.fn(test);
    const { container } = await renderSettings({ transport });

    await openProvider(container);
    expect(transport.discoverProviderModels).toHaveBeenCalledTimes(1);
    expect(transport.testProviderModel).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("48 ms");

    await click(button(container, "Details"));
    expect(container.textContent).toContain("Identity");
    expect(container.textContent).toContain("mock-model");
    expect(container.textContent).toContain("The Provider did not report context or output limits");
    expect(container.textContent).not.toContain("32,768 tokens");
    expect(container.textContent).not.toContain("4,096 tokens");
    expect(container.textContent).toContain("function call");
    expect(container.textContent).toContain("yes");
    expect(container.textContent).toContain("Reviewed catalog evidence");
    expect(container.textContent).toContain("Capability evidence");
    expect(container.textContent).toContain("Read only");

    await click(container.querySelector<HTMLButtonElement>(".rho-settings-back")!);
    expect(container.textContent).toContain("Mock model");
    expect(transport.discoverProviderModels).toHaveBeenCalledTimes(1);
    expect(transport.testProviderModel).toHaveBeenCalledTimes(1);
  });

  it("never presents internal fallbacks or unverified local declarations as model facts", async () => {
    const transport = createMockUiKernelTransport();
    const base = await transport.loadAgentLlmSettings();
    const current: AgentLlmSettingsView = {
      ...base,
      models: base.models.map((model) => ({
        ...model,
        model_type: { value: "language", source: "user_declared" },
        capabilities: {
          audio_input: { value: "no", source: "user_declared" },
          function_call: { value: "yes", source: "provider_response" },
        },
        context_window_tokens: 32_768,
        reserved_output_tokens: 4_096,
        context_capacity_source: "conservative_default",
        last_test: {
          status: "ready",
          checked_at: "2026-08-26T12:00:00Z",
          latency_ms: 91,
          error_class: null,
          message: "Connection succeeded.",
        },
      })),
    };
    transport.loadAgentLlmSettings = vi.fn(async () => structuredClone(current));
    transport.discoverProviderModels = vi.fn(async (providerId) => ({
      status: "ready",
      provider_id: providerId,
      models: current.models.map((model) => ({
        id: model.model_id,
        display_name: model.display_name,
        model_type: { value: "unknown", source: "unknown" },
        capabilities: {},
      })),
      truncated: false,
      message: "Loaded available models.",
      error_class: null,
    }));

    const { container } = await renderSettings({ transport });
    await openProvider(container);
    await click(button(container, "Details"));

    expect(container.textContent).toContain("Not reported");
    expect(container.textContent).not.toContain("32,768 tokens");
    expect(container.textContent).toContain("audio inputnoUnverified local metadata");
    expect(container.textContent).toContain("function callyesProvider test evidence");
    expect(container.textContent).not.toContain("Provider metadata");
  });

  it("adds then replaces an API key without retaining either plaintext in the page", async () => {
    const transport = createMockUiKernelTransport();
    const base = await transport.loadAgentLlmSettings();
    let current: AgentLlmSettingsView = {
      ...base,
      providers: base.providers.map((provider) => ({
        ...provider,
        credential_status: "not_detected",
        credential_effective_source: "not_configured",
        config_file_credential_present: false,
      })),
    };
    transport.loadAgentLlmSettings = vi.fn(async () => structuredClone(current));
    transport.discoverProviderModels = vi.fn(async (providerId) => ({
      status: "ready",
      provider_id: providerId,
      models: current.models.filter((model) => model.provider_id === providerId).map((model) => ({
        id: model.model_id,
        display_name: model.display_name,
        model_type: model.model_type,
        capabilities: model.capabilities,
      })),
      truncated: false,
      message: "Loaded 1 available model.",
      error_class: null,
    }));
    transport.testProviderModel = vi.fn(async (request) => {
      current = {
        ...current,
        revision: current.revision + 1,
        config_store: {
          ...current.config_store,
          config_snapshot_id: `${current.config_store.config_snapshot_id}:test`,
        },
        models: current.models.map((model) => model.id === request.modelId ? {
          ...model,
          last_test: {
            status: "ready",
            checked_at: "2026-08-26T12:00:00Z",
            latency_ms: 37,
            error_class: null,
            message: "Connection ready.",
          },
        } : model),
      };
      return structuredClone(current);
    });
    transport.saveProviderCredential = vi.fn(async (request) => {
      current = {
        ...current,
        revision: current.revision + 1,
        config_store: {
          ...current.config_store,
          config_snapshot_id: `${current.config_store.config_snapshot_id}:credential`,
        },
        providers: current.providers.map((provider) => provider.id === request.providerId ? {
          ...provider,
          credential_status: "detected",
          credential_effective_source: "config_file",
          config_file_credential_present: true,
        } : provider),
      };
      expect(request.confirmReplace).toBe(false);
      return structuredClone(current);
    });

    const { container } = await renderSettings({ transport });
    await openProvider(container);
    expect(container.textContent).toContain("Add API key");
    expect(container.textContent).not.toContain("Saved locally on this Mac");
    await click(button(container, "Add API key"));
    const addInput = container.querySelector<HTMLInputElement>("input[type='password']")!;
    await inputValue(addInput, "rho-add-sentinel");
    await click(button(container, "Save & verify"));
    expect(transport.saveProviderCredential).toHaveBeenCalledWith({
      providerId: "mock-provider",
      credential: "rho-add-sentinel",
      target: "config_file",
      confirmReplace: false,
      expectedRevision: base.revision,
      expectedConfigSnapshotId: base.config_store.config_snapshot_id,
    });
    expect(container.textContent).not.toContain("rho-add-sentinel");
    expect(container.textContent).toContain("API key verified");
    expect(container.textContent).toContain("37 ms");
    expect(transport.discoverProviderModels).toHaveBeenCalledWith("mock-provider");
    expect(transport.testProviderModel).toHaveBeenCalledWith(expect.objectContaining({ modelId: "mock-profile" }));

    transport.saveProviderCredential = vi.fn(async (request) => {
      expect(request.providerId).toBe("mock-provider");
      expect(request.target).toBe("config_file");
      expect(request.confirmReplace).toBe(true);
      current = {
        ...current,
        revision: current.revision + 1,
        config_store: {
          ...current.config_store,
          config_snapshot_id: `${current.config_store.config_snapshot_id}:replacement`,
        },
      };
      return structuredClone(current);
    });
    await click(button(container, "Replace"));
    const replaceInput = container.querySelector<HTMLInputElement>("input[type='password']")!;
    expect(replaceInput.value).toBe("");
    await inputValue(replaceInput, "rho-replace-sentinel");
    await click(button(container, "Save & verify"));
    expect(transport.saveProviderCredential).toHaveBeenCalledWith(expect.objectContaining({
      providerId: "mock-provider",
      credential: "rho-replace-sentinel",
      target: "config_file",
      confirmReplace: true,
    }));
    expect(container.textContent).not.toContain("rho-replace-sentinel");
    expect(container.textContent).toContain("API key verified");
  });

  it("can target the process session without writing the config-file slot", async () => {
    const transport = createMockUiKernelTransport();
    transport.saveProviderCredential = vi.fn(transport.saveProviderCredential);
    const { container } = await renderSettings({ transport });
    await openProvider(container);
    await click(button(container, "Replace"));
    const target = container.querySelector<HTMLSelectElement>("#rho-settings-credential-target")!;
    await selectValue(target, "session");
    expect(container.textContent).toContain("never written to disk");
    await inputValue(container.querySelector<HTMLInputElement>("input[type='password']")!, "rho-session-sentinel");
    await click(button(container, "Save & verify"));
    expect(transport.saveProviderCredential).toHaveBeenCalledWith(expect.objectContaining({
      providerId: "mock-provider",
      credential: "rho-session-sentinel",
      target: "session",
      confirmReplace: false,
    }));
    expect(container.textContent).not.toContain("rho-session-sentinel");
  });

  it("defaults every credential editor to config.yaml even when a session key is effective", async () => {
    const transport = createMockUiKernelTransport();
    const base = await transport.loadAgentLlmSettings();
    const current: AgentLlmSettingsView = {
      ...base,
      providers: base.providers.map((provider) => ({
        ...provider,
        credential_effective_source: "session",
        session_credential_present: true,
        config_file_credential_present: false,
      })),
    };
    transport.loadAgentLlmSettings = vi.fn(async () => structuredClone(current));
    transport.testProviderModel = vi.fn(async () => structuredClone(current));
    transport.saveProviderCredential = vi.fn(async () => structuredClone(current));

    const { container } = await renderSettings({ transport });
    await openProvider(container);
    await click(button(container, "Add API key"));
    const target = container.querySelector<HTMLSelectElement>("#rho-settings-credential-target")!;
    expect(target.value).toBe("config_file");

    await selectValue(target, "session");
    await inputValue(container.querySelector<HTMLInputElement>("input[type='password']")!, "rho-session-replace");
    await click(button(container, "Save & verify"));
    expect(transport.saveProviderCredential).toHaveBeenCalledWith(expect.objectContaining({
      target: "session",
      confirmReplace: true,
    }));
  });

  it("clears a failed replacement draft, reloads durable truth, and keeps other Providers isolated", async () => {
    const transport = createMockUiKernelTransport();
    const base = await transport.loadAgentLlmSettings();
    const second = {
      ...base.providers[0]!,
      id: "second-provider",
      display_name: "Second Provider",
      credential_status: "not_detected",
      credential_effective_source: "not_configured",
      config_file_credential_present: false,
    };
    const current: AgentLlmSettingsView = { ...base, providers: [...base.providers, second] };
    transport.loadAgentLlmSettings = vi.fn(async () => structuredClone(current));
    transport.testProviderModel = vi.fn(async () => structuredClone(current));
    transport.saveProviderCredential = vi.fn(async () => {
      throw new Error("Provider settings changed while saving");
    });
    const { container } = await renderSettings({ transport });
    await openProvider(container);
    await click(button(container, "Replace"));
    const input = container.querySelector<HTMLInputElement>("input[type='password']")!;
    await inputValue(input, "rho-failure-sentinel");
    await click(button(container, "Save & verify"));
    expect(input.value).toBe("");
    expect(container.textContent).not.toContain("rho-failure-sentinel");
    expect(container.textContent).toContain("Saved settings were reloaded");
    expect(transport.loadAgentLlmSettings).toHaveBeenCalledTimes(2);
    await click(button(container, "Second Provider"));
    expect(container.textContent).toContain("Add API key");
    expect(container.textContent).not.toContain("API key replaced");
    expect(container.querySelector(".rho-settings-row[aria-current='true']")?.textContent).toContain("Second Provider");
  });

  it("shows environment precedence, shadowing, and an explicit reveal", async () => {
    const transport = createMockUiKernelTransport();
    const base = await transport.loadAgentLlmSettings();
    const current: AgentLlmSettingsView = {
      ...base,
      providers: base.providers.map((provider) => ({
        ...provider,
        credential_status: "detected",
        credential_effective_source: "environment",
        env_shadows_file: true,
        session_credential_present: false,
        config_file_credential_present: true,
      })),
    };
    transport.loadAgentLlmSettings = vi.fn(async () => structuredClone(current));
    transport.testProviderModel = vi.fn(async () => structuredClone(current));
    transport.viewProviderCredential = vi.fn(async () => ({
      outcome: "revealed",
      credential: "mock-environment-api-key",
      source: "environment",
      env_shadows_file: true,
    } satisfies AgentLlmCredentialRevealView));
    const { container } = await renderSettings({ transport });
    await openProvider(container);
    expect(container.textContent).toContain("Environment · MOCK_API_KEY is effective");
    expect(container.textContent).toContain("shadows the API key saved in config.yaml");
    expect(container.textContent).toContain("View");
    expect(container.textContent).toContain("Replace");
    expect(container.querySelector("input[type='password']")).toBeNull();
    await click(button(container, "View"));
    expect(container.textContent).toContain("mock-environment-api-key");
  });

  it("recovers a failed Provider read and keeps Capabilities project-local and read-only", async () => {
    const transport = createMockUiKernelTransport("plugin=surface");
    const settings = await createMockUiKernelTransport().loadAgentLlmSettings();
    transport.loadAgentLlmSettings = vi.fn()
      .mockRejectedValueOnce(new Error("settings file unavailable"))
      .mockResolvedValueOnce({ ...settings, providers: [], models: [] });
    const { container, persist, root, instance } = await renderSettings({ transport, viewState: { module_id: "unknown" } });
    expect(container.textContent).toContain("settings file unavailable");
    await click(button(container, "Retry"));
    expect(container.textContent).toContain("No Providers");
    await click(button(container, "Capabilities"));
    expect(persist).toHaveBeenCalledWith({ module_id: "components" });
    expect(container.textContent).toContain("Built-in capabilities");
    expect(container.querySelectorAll("[data-capability-group]")).toHaveLength(5);
    expect(container.textContent).toContain("Core Workbench");
    expect(container.textContent).toContain("Agent Collaboration");
    expect(container.textContent).toContain("org.example.analysis");
    expect(container.querySelector(".rho-settings-components input")).toBeNull();

    const projectB = createMockUiKernelTransport("project=/projects/b");
    const projectBSurfaces = await projectB.loadSurfaces();
    await act(async () => {
      root.render(<SettingsSurfaceView
        instance={{ ...instance, project_id: projectBSurfaces.project_id }}
        transport={projectB}
        factories={projectBSurfaces.catalog.factories}
        persist={persist}
        reportError={vi.fn()}
      />);
      await settle();
    });
    expect(container.textContent).not.toContain("org.example.analysis");
    expect(container.textContent).toContain("Project extensions");
  });

  it("adds a discovered remote model with its evidence and removes the remote row", async () => {
    const transport = createMockUiKernelTransport();
    transport.discoverProviderModels = vi.fn(async (providerId) => ({
      status: "ready",
      provider_id: providerId,
      models: [{
        id: "mock-model",
        display_name: "Mock model",
        model_type: { value: "language", source: "catalog" },
        capabilities: { function_call: { value: "supported", source: "catalog" } },
      }, {
        id: "other-model",
        display_name: "Other model",
        model_type: { value: "language", source: "provider_response" },
        capabilities: { vision_input: { value: "yes", source: "provider_response" } },
      }],
      truncated: false,
      message: "Loaded 2 available models.",
      error_class: null,
    }));
    transport.saveModel = vi.fn(transport.saveModel);
    const { container } = await renderSettings({ transport });
    await openProvider(container);

    expect(container.textContent).toContain("Other model");
    expect(container.textContent).toContain("Available from Provider");
    await click(button(container, "Add"));

    expect(transport.saveModel).toHaveBeenCalledTimes(1);
    const saveRequest = (transport.saveModel as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    const profile = saveRequest.model;
    expect(profile).toMatchObject({
      id: "model-other-model",
      provider_id: "mock-provider",
      display_name: "Other model",
      model_id: "other-model",
      enabled: true,
      model_type: { value: "language", source: "provider_response" },
      context_window_tokens: 32_768,
      reserved_output_tokens: 4_096,
      context_capacity_source: "conservative_default",
      last_test: null,
    });
    expect(profile.capabilities.vision_input).toEqual({ value: "yes", source: "provider_response" });
    expect(profile.capabilities.reasoning).toEqual({ value: "unknown", source: "unknown" });
    expect(Object.keys(profile.capabilities)).toHaveLength(9);
    expect(container.textContent).toContain("Other model was added to Mock Provider.");
    expect(container.querySelector(".rho-settings-model-remote")).toBeNull();
    const articles = [...container.querySelectorAll(".rho-settings-model-list article")];
    expect(articles.some((article) => article.textContent?.includes("Other model")
      && !article.classList.contains("rho-settings-model-remote"))).toBe(true);
  });

  it("opens manual ID entry on failed discovery and persists honest unknown evidence", async () => {
    const transport = createMockUiKernelTransport();
    transport.discoverProviderModels = vi.fn(async (providerId) => ({
      status: "error",
      provider_id: providerId,
      models: [],
      truncated: false,
      message: "The API key was not accepted.",
      error_class: "credential_missing",
    }));
    transport.saveModel = vi.fn(transport.saveModel);
    const { container } = await renderSettings({ transport });
    await openProvider(container);

    const modelIdInput = container.querySelector<HTMLInputElement>("#rho-settings-manual-model-id");
    expect(modelIdInput).not.toBeNull();

    await inputValue(modelIdInput!, "mock-model");
    expect(container.textContent).toContain("This model ID is already configured for this Provider.");
    expect(button(container, "Add").disabled).toBe(true);

    await inputValue(modelIdInput!, "manual-model");
    expect(container.textContent).not.toContain("already configured");
    await click(button(container, "Add"));

    expect(transport.saveModel).toHaveBeenCalledTimes(1);
    const saveRequest = (transport.saveModel as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    const profile = saveRequest.model;
    expect(profile).toMatchObject({
      id: "model-manual-model",
      provider_id: "mock-provider",
      display_name: "manual-model",
      model_id: "manual-model",
      enabled: true,
      model_type: { value: "unknown", source: "unknown" },
      context_capacity_source: "conservative_default",
      last_test: null,
    });
    for (const capability of Object.values(profile.capabilities) as Array<{ value: string; source: string }>) {
      expect(capability).toEqual({ value: "unknown", source: "unknown" });
    }
    expect(container.textContent).toContain("manual-model was added to Mock Provider.");
    expect(container.querySelector("#rho-settings-manual-model-id")).toBeNull();
  });

  it("opens the Model options dialog prefilled and closes on Cancel and Escape without transport calls", async () => {
    const transport = createMockUiKernelTransport();
    transport.saveModel = vi.fn(transport.saveModel);
    transport.setModelContextCapacity = vi.fn(transport.setModelContextCapacity);
    transport.declareModelCapability = vi.fn(transport.declareModelCapability);
    const { container } = await renderSettings({ transport });
    await openProvider(container);
    await click(button(container, "Details"));
    await click(button(container, "Edit"));

    const dialog = () => container.querySelector<HTMLElement>("[role='dialog']");
    expect(dialog()).not.toBeNull();
    expect(dialog()!.getAttribute("aria-modal")).toBe("true");
    expect(dialog()!.textContent).toContain("Model options");
    const fields = dialog()!.querySelectorAll<HTMLInputElement>(".rho-settings-dialog-fields input");
    expect(fields[0]!.value).toBe("Mock model");
    expect(fields[1]!.value).toBe("mock-model");
    expect(fields[2]!.checked).toBe(true);
    expect(dialog()!.textContent).toContain("function call (auto)");
    expect(dialog()!.textContent).toContain("vision input (unknown)");
    const vision = dialog()!.querySelector<HTMLInputElement>("input[aria-label='Declare vision input']")!;
    expect(vision.indeterminate).toBe(true);
    expect(vision.checked).toBe(false);
    const numbers = dialog()!.querySelectorAll<HTMLInputElement>(".rho-settings-dialog-capacity input");
    expect(numbers[0]!.value).toBe("");
    expect(numbers[0]!.placeholder).toBe("Not reported");

    await inputValue(fields[0]!, "Discarded name");
    await click(button(dialog()!, "Cancel"));
    expect(dialog()).toBeNull();
    expect(transport.saveModel).not.toHaveBeenCalled();
    expect(transport.setModelContextCapacity).not.toHaveBeenCalled();
    expect(transport.declareModelCapability).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain("Discarded name");

    await click(button(container, "Edit"));
    expect(dialog()).not.toBeNull();
    expect(dialog()!.querySelector<HTMLInputElement>(".rho-settings-dialog-fields input")!.value).toBe("Mock model");
    await act(async () => {
      dialog()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await settle();
    });
    expect(dialog()).toBeNull();
    expect(transport.saveModel).not.toHaveBeenCalled();
  });

  it("saves details, capacity, and declarations in one ordered batched Save", async () => {
    const transport = createMockUiKernelTransport();
    const order: string[] = [];
    const saveModelImpl = transport.saveModel;
    transport.saveModel = vi.fn(async (model) => {
      order.push("saveModel");
      return saveModelImpl(model);
    });
    const capacityImpl = transport.setModelContextCapacity;
    transport.setModelContextCapacity = vi.fn(async (request) => {
      order.push("setModelContextCapacity");
      return capacityImpl(request);
    });
    const declareImpl = transport.declareModelCapability;
    transport.declareModelCapability = vi.fn(async (request) => {
      order.push("declareModelCapability");
      return declareImpl(request);
    });
    const { container } = await renderSettings({ transport });
    await openProvider(container);
    await click(button(container, "Details"));
    await click(button(container, "Edit"));

    const dialog = () => container.querySelector<HTMLElement>("[role='dialog']")!;
    const displayInput = dialog().querySelector<HTMLInputElement>(".rho-settings-dialog-fields input")!;
    await inputValue(displayInput, "Renamed mock");
    const reasoning = dialog().querySelector<HTMLInputElement>("input[aria-label='Declare reasoning']")!;
    const vision = dialog().querySelector<HTMLInputElement>("input[aria-label='Declare vision input']")!;
    await act(async () => { reasoning.click(); await settle(); });
    await act(async () => { vision.click(); await settle(); });
    expect(reasoning.checked).toBe(true);
    expect(reasoning.indeterminate).toBe(false);
    await selectValue(dialog().querySelector<HTMLSelectElement>("select[aria-label='Declare model type']")!, "embedding");
    const numbers = dialog().querySelectorAll<HTMLInputElement>(".rho-settings-dialog-capacity input");
    await inputValue(numbers[0]!, "64000");
    await inputValue(numbers[1]!, "8192");
    await click(button(dialog(), "Save"));

    expect(order).toEqual([
      "saveModel",
      "setModelContextCapacity",
      "declareModelCapability",
      "declareModelCapability",
      "declareModelCapability",
    ]);
    const profile = (transport.saveModel as ReturnType<typeof vi.fn>).mock.calls[0]![0].model;
    expect(profile).toMatchObject({
      id: "mock-profile",
      display_name: "Renamed mock",
      model_id: "mock-model",
      enabled: true,
      model_type: { value: "language", source: "aisdk_catalog" },
      capabilities: { function_call: { value: "yes", source: "aisdk_catalog" } },
    });
    expect(transport.setModelContextCapacity).toHaveBeenCalledWith({
      modelId: "mock-profile",
      expectedRevision: 3,
      expectedConfigSnapshotId: "mock-config-snapshot-3",
      contextWindowTokens: 64_000,
      reservedOutputTokens: 8_192,
    });
    const declares = (transport.declareModelCapability as ReturnType<typeof vi.fn>).mock.calls
      .map((call) => call[0]);
    expect(declares).toEqual([
      { modelId: "mock-profile", expectedRevision: 4, expectedConfigSnapshotId: "mock-config-snapshot-4", capability: "model_type", value: "embedding" },
      { modelId: "mock-profile", expectedRevision: 5, expectedConfigSnapshotId: "mock-config-snapshot-5", capability: "reasoning", value: "yes" },
      { modelId: "mock-profile", expectedRevision: 6, expectedConfigSnapshotId: "mock-config-snapshot-6", capability: "vision_input", value: "yes" },
    ]);
    expect(container.querySelector("[role='dialog']")).toBeNull();
    expect(container.textContent).toContain("Model options saved.");
    expect(container.textContent).toContain("Renamed mock");
    expect(container.textContent).toContain("64,000 tokens");
  });

  it("keeps the dialog open on a failed step, skips later steps, reloads truth, and retries", async () => {
    const transport = createMockUiKernelTransport();
    transport.setModelContextCapacity = vi.fn(transport.setModelContextCapacity);
    const declareImpl = transport.declareModelCapability;
    let failDeclare = true;
    transport.declareModelCapability = vi.fn(async (request) => {
      if (failDeclare) {
        throw new Error("Model settings changed while this capability editor was open. Reload and try again.");
      }
      return declareImpl(request);
    });
    transport.loadAgentLlmSettings = vi.fn(transport.loadAgentLlmSettings);
    const { container } = await renderSettings({ transport });
    await openProvider(container);
    await click(button(container, "Details"));
    await click(button(container, "Edit"));

    const dialog = () => container.querySelector<HTMLElement>("[role='dialog']")!;
    const numbers = dialog().querySelectorAll<HTMLInputElement>(".rho-settings-dialog-capacity input");
    await inputValue(numbers[0]!, "64000");
    await inputValue(numbers[1]!, "8192");
    await act(async () => {
      dialog().querySelector<HTMLInputElement>("input[aria-label='Declare reasoning']")!.click();
      await settle();
    });
    await act(async () => {
      dialog().querySelector<HTMLInputElement>("input[aria-label='Declare vision input']")!.click();
      await settle();
    });
    const loadsBefore = (transport.loadAgentLlmSettings as ReturnType<typeof vi.fn>).mock.calls.length;
    await click(button(dialog(), "Save"));

    expect(dialog()).not.toBeNull();
    expect(dialog().textContent).toContain("Model settings changed while this capability editor was open.");
    expect(transport.setModelContextCapacity).toHaveBeenCalledTimes(1);
    expect(transport.declareModelCapability).toHaveBeenCalledTimes(1);
    expect((transport.loadAgentLlmSettings as ReturnType<typeof vi.fn>).mock.calls.length)
      .toBe(loadsBefore + 1);

    failDeclare = false;
    await click(button(dialog(), "Save"));
    expect(dialog()).toBeNull();
    expect(container.textContent).toContain("Model options saved.");
    const declares = (transport.declareModelCapability as ReturnType<typeof vi.fn>).mock.calls
      .map((call) => call[0]);
    expect(declares).toHaveLength(3);
    expect(declares[1]).toMatchObject({ capability: "reasoning", value: "yes" });
    expect(declares[2]).toMatchObject({ capability: "vision_input", value: "yes" });
  });

  it("surfaces the route guard on confirmed delete and reloads durable truth", async () => {
    const transport = createMockUiKernelTransport();
    transport.deleteModel = vi.fn(transport.deleteModel);
    transport.loadAgentLlmSettings = vi.fn(transport.loadAgentLlmSettings);
    const { container } = await renderSettings({ transport });
    await openProvider(container);
    await click(button(container, "Details"));

    await click(button(container, "Delete this model"));
    expect(container.textContent).toContain("This cannot be undone.");
    await click(button(container, "Confirm delete"));

    expect(transport.deleteModel).toHaveBeenCalledWith(expect.objectContaining({
      modelId: "mock-profile",
      replacementModelId: null,
    }));
    expect(container.textContent).toContain("Reassign or remove this model's capability routes before deleting it.");
    expect(container.textContent).toContain("Saved settings were reloaded.");
    expect(container.textContent).toContain("Capability evidence");
  });

  it("presents catalog-projected capacity as reported model facts", async () => {
    const transport = createMockUiKernelTransport();
    const base = await transport.loadAgentLlmSettings();
    const current: AgentLlmSettingsView = {
      ...base,
      models: base.models.map((model) => ({
        ...model,
        context_window_tokens: 1_000_000,
        reserved_output_tokens: 384_000,
        context_capacity_source: "catalog",
      })),
    };
    transport.loadAgentLlmSettings = vi.fn(async () => structuredClone(current));
    transport.testProviderModel = vi.fn(async () => structuredClone(current));
    const { container } = await renderSettings({ transport });
    await openProvider(container);
    await click(button(container, "Details"));

    expect(container.textContent).toContain("1,000,000 tokens");
    expect(container.textContent).toContain("384,000 tokens");
    expect(container.textContent).not.toContain("Not reported");
    expect(container.textContent).not.toContain("internal safety fallback");
  });

  it("prefills catalog capacity in the dialog and only saves capacity when the pair changes", async () => {
    const transport = createMockUiKernelTransport();
    const base = await transport.loadAgentLlmSettings();
    let current: AgentLlmSettingsView = {
      ...base,
      models: base.models.map((model) => ({
        ...model,
        context_window_tokens: 1_000_000,
        reserved_output_tokens: 384_000,
        context_capacity_source: "catalog",
      })),
    };
    transport.loadAgentLlmSettings = vi.fn(async () => structuredClone(current));
    transport.testProviderModel = vi.fn(async () => structuredClone(current));
    transport.saveModel = vi.fn(async (request) => {
      const { model: profile } = request;
      current = {
        ...current,
        revision: current.revision + 1,
        models: current.models.map((model) => model.id === profile.id ? { ...model, ...profile } : model),
      };
      return structuredClone(current);
    });
    transport.setModelContextCapacity = vi.fn(async (request) => {
      current = {
        ...current,
        revision: current.revision + 1,
        models: current.models.map((model) => model.id === request.modelId ? {
          ...model,
          context_window_tokens: request.contextWindowTokens,
          reserved_output_tokens: request.reservedOutputTokens,
          context_capacity_source: "user_declared",
        } : model),
      };
      return structuredClone(current);
    });
    transport.declareModelCapability = vi.fn(transport.declareModelCapability);
    const { container } = await renderSettings({ transport });
    await openProvider(container);
    await click(button(container, "Details"));
    await click(button(container, "Edit"));

    const dialog = () => container.querySelector<HTMLElement>("[role='dialog']");
    const numbers = () => dialog()!.querySelectorAll<HTMLInputElement>(".rho-settings-dialog-capacity input");
    expect(numbers()[0]!.value).toBe("1000000");
    expect(numbers()[1]!.value).toBe("384000");

    // Unchanged prefilled capacity: Save persists details only.
    await inputValue(dialog()!.querySelector<HTMLInputElement>(".rho-settings-dialog-fields input")!, "Renamed mock");
    await click(button(dialog()!, "Save"));
    expect(transport.saveModel).toHaveBeenCalledTimes(1);
    expect(transport.setModelContextCapacity).not.toHaveBeenCalled();
    expect(transport.declareModelCapability).not.toHaveBeenCalled();
    expect(dialog()).toBeNull();

    // Editing one value declares the pair with the latest revision.
    await click(button(container, "Edit"));
    expect(numbers()[0]!.value).toBe("1000000");
    await inputValue(numbers()[1]!, "384001");
    await click(button(dialog()!, "Save"));
    expect(transport.setModelContextCapacity).toHaveBeenCalledTimes(1);
    expect(transport.setModelContextCapacity).toHaveBeenCalledWith({
      modelId: "mock-profile",
      expectedRevision: 2,
      expectedConfigSnapshotId: base.config_store.config_snapshot_id,
      contextWindowTokens: 1_000_000,
      reservedOutputTokens: 384_001,
    });
    expect(dialog()).toBeNull();

    // A half-cleared pair is rejected with the paired-field message, in-dialog.
    await click(button(container, "Edit"));
    await inputValue(numbers()[1]!, "");
    await click(button(dialog()!, "Save"));
    expect(dialog()).not.toBeNull();
    expect(dialog()!.textContent).toContain(
      "Capacity is declared as a pair — enter both context window and max output limits.",
    );
    expect(transport.setModelContextCapacity).toHaveBeenCalledTimes(1);
  });

  it("deletes an unrouted model after confirmation and returns to the Provider", async () => {
    const transport = createMockUiKernelTransport();
    transport.discoverProviderModels = vi.fn(async (providerId) => ({
      status: "ready",
      provider_id: providerId,
      models: [{
        id: "mock-model",
        display_name: "Mock model",
        model_type: { value: "language", source: "catalog" },
        capabilities: { function_call: { value: "supported", source: "catalog" } },
      }, {
        id: "other-model",
        display_name: "Other model",
        model_type: { value: "language", source: "provider_response" },
        capabilities: {},
      }],
      truncated: false,
      message: "Loaded 2 available models.",
      error_class: null,
    }));
    const { container } = await renderSettings({ transport });
    await openProvider(container);
    await click(button(container, "Add"));
    expect(container.textContent).toContain("Other model was added to Mock Provider.");

    const otherRow = [...container.querySelectorAll(".rho-settings-model-list article")]
      .find((article) => article.textContent?.includes("Other model"))!;
    await click(otherRow.querySelector<HTMLButtonElement>("button")!);
    expect(container.textContent).toContain("Identity");
    await click(button(container, "Delete this model"));
    await click(button(container, "Confirm delete"));

    expect(container.textContent).toContain("Other model was deleted.");
    expect(container.textContent).toContain("Models");
    expect(container.textContent).not.toContain("Identity");
    const remaining = await transport.loadAgentLlmSettings();
    expect(remaining.models.map((model) => model.id)).toEqual(["mock-profile"]);
  });
});
