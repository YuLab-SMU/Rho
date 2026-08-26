import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AgentLlmSettingsView, SurfaceInstance } from "../transport";
import { createMockUiKernelTransport } from "../transport/mock";
import {
  SettingsSurfaceView,
  settingsModuleFromViewState,
} from "./SettingsSurfaceView";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

async function settle() {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

describe("plugin-native Settings Surface", () => {
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

  it("uses a closed module registry and falls back from malformed view state", () => {
    expect(settingsModuleFromViewState({ module_id: "components" })).toBe("components");
    expect(settingsModuleFromViewState({ module_id: "workspace-secret" })).toBe("models");
    expect(settingsModuleFromViewState({ module_id: 42 })).toBe("models");
    expect(settingsModuleFromViewState(null)).toBe("models");
  });

  it("assigns Chat and capacity through the displayed revision without exposing credential input", async () => {
    const transport = createMockUiKernelTransport();
    const base = await transport.loadAgentLlmSettings();
    const alternate = {
      ...base.models[0]!,
      id: "mock-profile-alternate",
      display_name: "Alternate model",
      model_id: "alternate-model",
      selected: false,
      context_window_tokens: 65_536,
      reserved_output_tokens: 8_192,
    };
    let current: AgentLlmSettingsView = { ...base, models: [...base.models, alternate] };
    transport.loadAgentLlmSettings = vi.fn(async () => structuredClone(current));
    transport.selectAgentChatModel = vi.fn(async (modelId, expectedRevision) => {
      expect(expectedRevision).toBe(current.revision);
      const model = current.models.find((candidate) => candidate.id === modelId)!;
      current = {
        ...current,
        revision: current.revision + 1,
        selected_model_id: model.id,
        selected_model: {
          id: model.id,
          display_name: model.display_name,
          provider_display_name: model.provider_display_name,
          selector_status: model.selector_status,
          tool_calling: model.capabilities.function_call?.value ?? "unknown",
          act_enabled: model.act_enabled,
        },
        models: current.models.map((candidate) => ({ ...candidate, selected: candidate.id === model.id })),
        capability_routes: current.capability_routes.map((route) => route.capability === "agent.chat" ? {
          ...route,
          model_id: model.id,
          model_display_name: model.display_name,
          provider_display_name: model.provider_display_name,
        } : route),
      };
      return structuredClone(current);
    });
    transport.setAgentContextCapacity = vi.fn(async (request) => {
      expect(request.expected_revision).toBe(current.revision);
      current = {
        ...current,
        revision: current.revision + 1,
        models: current.models.map((model) => model.id === request.model_id ? {
          ...model,
          context_window_tokens: request.context_window_tokens,
          reserved_output_tokens: request.reserved_output_tokens,
          context_capacity_source: "user_declared",
        } : model),
      };
      return structuredClone(current);
    });
    const { container } = await renderSettings({ transport });

    expect(container.textContent).toContain("system store");
    expect(container.querySelector("input[type='password']")).toBeNull();
    await act(async () => {
      [...container.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent === "Use for Chat")!.click();
      await settle();
    });
    expect(transport.selectAgentChatModel).toHaveBeenCalledWith("mock-profile-alternate", 1);
    expect(container.querySelector("[aria-current='true']")?.textContent).toContain("Alternate model");

    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    const setSelect = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
    await act(async () => {
      const model = container.querySelector<HTMLSelectElement>("[aria-label='Capacity model']")!;
      setSelect.call(model, "mock-profile-alternate");
      model.dispatchEvent(new Event("change", { bubbles: true }));
      await settle();
      const context = container.querySelector<HTMLInputElement>("[aria-label='Settings context window tokens']")!;
      const reserved = container.querySelector<HTMLInputElement>("[aria-label='Settings reserved output tokens']")!;
      setValue.call(context, "131072");
      context.dispatchEvent(new Event("input", { bubbles: true }));
      setValue.call(reserved, "16384");
      reserved.dispatchEvent(new Event("input", { bubbles: true }));
      container.querySelector<HTMLButtonElement>(".rho-settings-capacity button[type='submit']")!.click();
      await settle();
    });
    expect(transport.setAgentContextCapacity).toHaveBeenCalledWith({
      model_id: "mock-profile-alternate",
      expected_revision: 2,
      context_window_tokens: 131_072,
      reserved_output_tokens: 16_384,
    });
    expect(container.textContent).toContain("user declared");

    await act(async () => {
      const context = container.querySelector<HTMLInputElement>("[aria-label='Settings context window tokens']")!;
      const reserved = container.querySelector<HTMLInputElement>("[aria-label='Settings reserved output tokens']")!;
      setValue.call(context, "4096");
      context.dispatchEvent(new Event("input", { bubbles: true }));
      setValue.call(reserved, "4096");
      reserved.dispatchEvent(new Event("input", { bubbles: true }));
      container.querySelector<HTMLButtonElement>(".rho-settings-capacity button[type='submit']")!.click();
      await settle();
    });
    expect(container.querySelector(".rho-settings-capacity [role='alert']")?.textContent).toContain("smaller than context");
    expect(transport.setAgentContextCapacity).toHaveBeenCalledTimes(1);
  });

  it("reloads durable truth after a stale mutation and keeps the failure visible", async () => {
    const transport = createMockUiKernelTransport();
    const base = await transport.loadAgentLlmSettings();
    const alternate = { ...base.models[0]!, id: "alternate", display_name: "Alternate", model_id: "alternate", selected: false };
    const initial: AgentLlmSettingsView = { ...base, models: [...base.models, alternate] };
    const reloaded: AgentLlmSettingsView = { ...initial, revision: 7 };
    transport.loadAgentLlmSettings = vi.fn()
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(reloaded);
    transport.selectAgentChatModel = vi.fn(async () => {
      throw new Error("Model settings changed while this selector was open");
    });
    const { container } = await renderSettings({ transport });
    await act(async () => {
      [...container.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent === "Use for Chat")!.click();
      await settle();
    });
    expect(transport.loadAgentLlmSettings).toHaveBeenCalledTimes(2);
    expect(container.querySelector("[role='alert']")?.textContent).toContain("settings changed");
    expect(container.textContent).toContain("revision 7");
    expect(container.querySelector("[aria-current='true']")?.textContent).toContain("Mock model");
  });

  it("recovers a failed read and keeps component origins project-local and read-only", async () => {
    const transport = createMockUiKernelTransport("plugin=surface");
    const settings = await createMockUiKernelTransport().loadAgentLlmSettings();
    transport.loadAgentLlmSettings = vi.fn()
      .mockRejectedValueOnce(new Error("settings file unavailable"))
      .mockResolvedValueOnce({ ...settings, providers: [], models: [], selected_model: null });
    const { container, persist, root, instance } = await renderSettings({ transport, viewState: { module_id: "unknown" } });
    expect(container.textContent).toContain("settings file unavailable");
    await act(async () => {
      [...container.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent === "Retry")!.click();
      await settle();
    });
    expect(container.textContent).toContain("No enabled language model");
    await act(async () => {
      [...container.querySelectorAll<HTMLButtonElement>("[role='tab']")]
        .find((button) => button.textContent?.includes("Components"))!.click();
      await settle();
    });
    expect(persist).toHaveBeenCalledWith({ module_id: "components" });
    expect(container.textContent).toContain("rho.settings");
    expect(container.textContent).toContain("org.example.analysis");
    expect(container.textContent).toContain("Current project");
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
    expect(container.textContent).toContain("Current project");
  });
});
