import { describe, expect, it } from "vitest";

import {
  buildAddedModelProfile,
  CONSERVATIVE_CONTEXT_WINDOW_TOKENS,
  CONSERVATIVE_RESERVED_OUTPUT_TOKENS,
  createTauriAgentSettingsTransport,
  MODEL_CAPABILITY_NAMES,
  type AgentContextCapacityRequest,
  type AgentLlmSettingsView,
  type AgentSettingsTransport,
} from "./agent-settings";
import { createMockUiKernelTransport } from "./mock";

const settings = {
  schema_version: 5,
  revision: 9,
  selected_model_id: "model:fixture",
  providers: [{
    id: "provider:fixture",
    display_name: "Fixture Provider",
    kind: "openai_compatible",
    registered_provider_id: null,
    api_key_env: "FIXTURE_API_KEY",
    api_key_required: true,
    base_url: "https://example.invalid/v1",
    base_url_env: null,
    wire_api: "openai",
    disable_stream_options: false,
    credential_source: "rho_vault",
    credential_status: "unchecked",
    credential_effective_source: "unchecked",
    effective_base_url: "https://example.invalid/v1",
    base_url_source: "configured",
  }],
  models: [{
    id: "model:fixture",
    provider_id: "provider:fixture",
    display_name: "Fixture Model",
    model_id: "fixture-model",
    enabled: true,
    model_type: { value: "language", source: "catalog" },
    capabilities: {
      function_call: { value: "supported", source: "catalog" },
    },
    context_window_tokens: 128_000,
    reserved_output_tokens: 8_192,
    context_capacity_source: "catalog",
    last_test: null,
    provider_display_name: "Fixture Provider",
    selected: true,
    selector_status: "ready",
    act_enabled: true,
  }],
  selected_model: {
    id: "model:fixture",
    display_name: "Fixture Model",
    provider_display_name: "Fixture Provider",
    selector_status: "ready",
    tool_calling: "supported",
    act_enabled: true,
  },
  capability_routes: [{
    capability: "agent.chat",
    label: "Chat",
    description: "Ordinary Agent conversation",
    model_id: "model:fixture",
    model_display_name: "Fixture Model",
    provider_display_name: "Fixture Provider",
    model_type: "language",
    required_model_capabilities: [],
    configured: true,
    inherited_from: null,
    compatibility: "ready",
    credential_status: "unchecked",
    consumer_status: "ready",
  }],
  user_environ: {
    path: "/Users/fixture/.Renviron",
    source: "not_used_for_agent_credentials",
  },
  validation_error: null,
} satisfies AgentLlmSettingsView;

const request = {
  model_id: settings.selected_model_id,
  expected_revision: settings.revision,
  context_window_tokens: 262_144,
  reserved_output_tokens: 16_384,
} satisfies AgentContextCapacityRequest;

describe("Agent settings generated transport", () => {
  it("owns the query and exact nested capacity request", async () => {
    const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
    const transport = createTauriAgentSettingsTransport(
      async <T,>(command: string, args?: Record<string, unknown>): Promise<T> => {
        calls.push(args === undefined ? { command } : { command, args });
        return settings as T;
      },
    );

    await expect(transport.loadAgentLlmSettings()).resolves.toBe(settings);
    await expect(transport.selectAgentChatModel("model:alternate", 9)).resolves.toBe(settings);
    await expect(transport.setAgentContextCapacity(request)).resolves.toBe(settings);
    const added = buildAddedModelProfile({
      providerId: "provider:fixture",
      modelId: "fixture-model",
    });
    expect(added).toMatchObject({
      id: "model-fixture-model",
      provider_id: "provider:fixture",
      display_name: "fixture-model",
      enabled: true,
      model_type: { value: "unknown", source: "unknown" },
      context_window_tokens: CONSERVATIVE_CONTEXT_WINDOW_TOKENS,
      reserved_output_tokens: CONSERVATIVE_RESERVED_OUTPUT_TOKENS,
      context_capacity_source: "conservative_default",
      last_test: null,
    });
    expect(Object.keys(added.capabilities).sort()).toEqual([...MODEL_CAPABILITY_NAMES].sort());
    await expect(transport.saveModel(added)).resolves.toBe(settings);
    await expect(transport.deleteModel("model-fixture-model")).resolves.toBe(settings);
    await expect(transport.setModelContextCapacity(request)).resolves.toBe(settings);
    await expect(transport.declareModelCapability({
      model_id: "model:fixture",
      expected_revision: 9,
      capability: "vision_input",
      value: "yes",
    })).resolves.toBe(settings);
    expect(calls).toEqual([
      { command: "agent_llm_settings" },
      {
        command: "agent_llm_select_model",
        args: { request: { modelId: "model:alternate", expectedRevision: 9 } },
      },
      { command: "agent_llm_set_context_capacity", args: { request } },
      { command: "agent_llm_save_model", args: { model: added } },
      {
        command: "agent_llm_delete_model",
        args: { request: { model_id: "model-fixture-model", replacement_model_id: null } },
      },
      { command: "agent_llm_set_context_capacity", args: { request } },
      {
        command: "agent_llm_declare_model_capability",
        args: {
          request: {
            model_id: "model:fixture",
            expected_revision: 9,
            capability: "vision_input",
            value: "yes",
          },
        },
      },
    ]);
  });

  it("preserves stale revision rejection", async () => {
    const transport = createTauriAgentSettingsTransport(async () => {
      throw new Error("Model settings changed while this editor was open");
    });
    await expect(transport.setAgentContextCapacity(request)).rejects.toThrow("settings changed");
    await expect(transport.selectAgentChatModel("model:fixture", 8)).rejects.toThrow("settings changed");
  });

  it("keeps the mock presentation safe and assignable to the narrow facet", async () => {
    const transport: AgentSettingsTransport = createMockUiKernelTransport();
    const projected = await transport.loadAgentLlmSettings();
    expect(projected.providers[0]).toMatchObject({ credential_status: "detected" });
    expect(JSON.stringify(projected)).not.toContain("fixture-secret");
  });
});
