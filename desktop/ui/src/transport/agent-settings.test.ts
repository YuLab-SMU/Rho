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
  schema_version: 6,
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
    wire_api: "chat_completions",
    disable_stream_options: false,
    credential_status: "unchecked",
    credential_effective_source: "not_configured",
    env_shadows_file: false,
    session_credential_present: false,
    config_file_credential_present: false,
    effective_base_url: "https://example.invalid/v1",
    base_url_source: "configured",
  }],
  models: [{
    id: "model:fixture",
    provider_id: "provider:fixture",
    display_name: "Fixture Model",
    model_id: "fixture-model",
    enabled: true,
    model_type: { value: "language", source: "aisdk_catalog" },
    capabilities: {
      function_call: { value: "yes", source: "aisdk_catalog" },
      reasoning: { value: "unknown", source: "unknown" },
      vision_input: { value: "unknown", source: "unknown" },
      image_output: { value: "unknown", source: "unknown" },
      image_edit: { value: "unknown", source: "unknown" },
      audio_input: { value: "unknown", source: "unknown" },
      audio_output: { value: "unknown", source: "unknown" },
      structured_output: { value: "unknown", source: "unknown" },
      web_search: { value: "unknown", source: "unknown" },
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
    tool_calling: "yes",
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
  config_store: {
    home_path: "/Users/fixture/.rho",
    config_path: "/Users/fixture/.rho/config.yaml",
    status: "loaded",
    detail: null,
    found_schema_version: 6,
    config_snapshot_id: "config-snapshot:9",
    permission_issues: [],
  },
  validation_error: null,
} satisfies AgentLlmSettingsView;

const request = {
  modelId: settings.selected_model_id,
  expectedRevision: settings.revision,
  expectedConfigSnapshotId: settings.config_store.config_snapshot_id,
  contextWindowTokens: 262_144,
  reservedOutputTokens: 16_384,
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
    const provider = {
      id: "provider:new", display_name: "New Provider", kind: "openai", registered_provider_id: null,
      api_key_env: "NEW_API_KEY", api_key_required: true, base_url: null, base_url_env: null,
      wire_api: null, disable_stream_options: null,
    };
    await expect(transport.connectProvider({
      provider,
      apiKey: "session-secret",
      expectedRevision: 9,
      expectedConfigSnapshotId: "config-snapshot:9",
    })).resolves.toBe(settings);
    await expect(transport.saveProvider({
      provider,
      expectedRevision: 9,
      expectedConfigSnapshotId: "config-snapshot:9",
    })).resolves.toBe(settings);
    await expect(transport.deleteProvider({
      providerId: provider.id,
      expectedRevision: 9,
      expectedConfigSnapshotId: "config-snapshot:9",
    })).resolves.toBe(settings);
    await expect(transport.repairAgentConfigPermissions({
      expectedConfigPath: settings.config_store.config_path!,
      expectedRevision: settings.revision,
      expectedConfigSnapshotId: settings.config_store.config_snapshot_id,
    })).resolves.toBe(settings);
    await expect(transport.selectAgentChatModel({
      modelId: "model:alternate",
      expectedRevision: 9,
      expectedConfigSnapshotId: "config-snapshot:9",
    })).resolves.toBe(settings);
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
    await expect(transport.saveModel({
      model: added,
      expectedRevision: 9,
      expectedConfigSnapshotId: "config-snapshot:9",
    })).resolves.toBe(settings);
    await expect(transport.deleteModel({
      modelId: "model-fixture-model",
      replacementModelId: null,
      expectedRevision: 9,
      expectedConfigSnapshotId: "config-snapshot:9",
    })).resolves.toBe(settings);
    await expect(transport.setModelContextCapacity(request)).resolves.toBe(settings);
    await expect(transport.declareModelCapability({
      modelId: "model:fixture",
      expectedRevision: 9,
      expectedConfigSnapshotId: "config-snapshot:9",
      capability: "vision_input",
      value: "yes",
    })).resolves.toBe(settings);
    expect(calls).toEqual([
      { command: "agent_llm_settings" },
      { command: "agent_llm_connect_provider", args: { request: {
        provider,
        apiKey: "session-secret",
        expectedRevision: 9,
        expectedConfigSnapshotId: "config-snapshot:9",
      } } },
      { command: "agent_llm_save_provider", args: { request: {
        provider,
        expectedRevision: 9,
        expectedConfigSnapshotId: "config-snapshot:9",
      } } },
      { command: "agent_llm_delete_provider", args: { request: {
        providerId: provider.id,
        expectedRevision: 9,
        expectedConfigSnapshotId: "config-snapshot:9",
      } } },
      {
        command: "agent_llm_repair_config_permissions",
        args: { request: {
          expectedConfigPath: "/Users/fixture/.rho/config.yaml",
          expectedRevision: 9,
          expectedConfigSnapshotId: "config-snapshot:9",
        } },
      },
      {
        command: "agent_llm_select_model",
        args: { request: {
          modelId: "model:alternate",
          expectedRevision: 9,
          expectedConfigSnapshotId: "config-snapshot:9",
        } },
      },
      { command: "agent_llm_set_context_capacity", args: { request } },
      { command: "agent_llm_save_model", args: { request: {
        model: added,
        expectedRevision: 9,
        expectedConfigSnapshotId: "config-snapshot:9",
      } } },
      {
        command: "agent_llm_delete_model",
        args: { request: {
          modelId: "model-fixture-model",
          replacementModelId: null,
          expectedRevision: 9,
          expectedConfigSnapshotId: "config-snapshot:9",
        } },
      },
      { command: "agent_llm_set_context_capacity", args: { request } },
      {
        command: "agent_llm_declare_model_capability",
        args: {
          request: {
            modelId: "model:fixture",
            expectedRevision: 9,
            expectedConfigSnapshotId: "config-snapshot:9",
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
    await expect(transport.selectAgentChatModel({
      modelId: "model:fixture",
      expectedRevision: 8,
      expectedConfigSnapshotId: "config-snapshot:9",
    })).rejects.toThrow("settings changed");
  });

  it("keeps the mock presentation safe and assignable to the narrow facet", async () => {
    const transport: AgentSettingsTransport = createMockUiKernelTransport();
    const projected = await transport.loadAgentLlmSettings();
    expect(projected.providers[0]).toMatchObject({ credential_status: "detected" });
    expect(JSON.stringify(projected)).not.toContain("fixture-secret");
  });
});
