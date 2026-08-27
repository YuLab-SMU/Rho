import {
  createAgentSettingsCommands,
  type AgentContextCapacityRequest as AgentContextCapacityRequestWire,
  type AgentLlmCredentialRevealView as AgentLlmCredentialRevealViewWire,
  type AgentLlmSettingsView as AgentLlmSettingsViewWire,
  type AgentModelCapabilityDeclarationRequest as AgentModelCapabilityDeclarationRequestWire,
  type AgentModelDiscoveryResponse as AgentModelDiscoveryResponseWire,
  type AgentModelProfile as AgentModelProfileWire,
  type AgentModelProfileView as AgentModelProfileViewWire,
  type AgentSettingsInvoke,
} from "./generated/agent-settings";

type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer Item)[]
    ? readonly DeepReadonly<Item>[]
    : T extends object
      ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
      : T;

export type AgentModelContextCapacity = DeepReadonly<AgentModelProfileViewWire>;
export type AgentLlmSettingsView = DeepReadonly<AgentLlmSettingsViewWire>;
export type AgentLlmCredentialRevealView = DeepReadonly<AgentLlmCredentialRevealViewWire>;
export type AgentModelDiscoveryResponse = DeepReadonly<AgentModelDiscoveryResponseWire>;
export type AgentContextCapacityRequest = DeepReadonly<AgentContextCapacityRequestWire>;
export type AgentModelProfile = AgentModelProfileWire;
export type AgentModelCapabilityDeclarationRequest = AgentModelCapabilityDeclarationRequestWire;

/**
 * The nine pinned capability attributes, mirroring `capability_names()` in
 * `desktop/src-tauri/src/agent_llm.rs`.
 */
export const MODEL_CAPABILITY_NAMES = [
  "function_call",
  "reasoning",
  "vision_input",
  "image_output",
  "image_edit",
  "audio_input",
  "audio_output",
  "structured_output",
  "web_search",
] as const;

/**
 * Internal safety fallbacks for a model whose Provider never reported
 * capacity. Mirrors `CONSERVATIVE_CONTEXT_WINDOW_TOKENS` /
 * `CONSERVATIVE_RESERVED_OUTPUT_TOKENS` in
 * `desktop/src-tauri/src/agent_llm.rs`; never presented as model capacity.
 */
export const CONSERVATIVE_CONTEXT_WINDOW_TOKENS = 32_768;
export const CONSERVATIVE_RESERVED_OUTPUT_TOKENS = 4_096;

const unknownCapabilityDefaults = (): AgentModelProfileWire["capabilities"] =>
  Object.fromEntries(
    MODEL_CAPABILITY_NAMES.map((name) => [name, { value: "unknown", source: "unknown" }]),
  );

/**
 * Builds the complete profile persisted when a model is added to a Provider:
 * from a discovered (catalog-enriched) row the discovered evidence is kept
 * with its provenance, and for a manually entered ID every attribute stays
 * honestly `unknown`/`unknown`. Capacity is the internal conservative
 * fallback and no route is assigned by adding.
 */
export function buildAddedModelProfile(input: {
  readonly providerId: string;
  readonly modelId: string;
  readonly displayName?: string;
  readonly discovered?: AgentModelDiscoveryResponse["models"][number];
}): AgentModelProfile {
  const capabilities = unknownCapabilityDefaults();
  if (input.discovered != null) {
    for (const [name, capability] of Object.entries(input.discovered.capabilities)) {
      capabilities[name] = { value: capability.value, source: capability.source };
    }
  }
  return {
    id: `model-${input.modelId}`,
    provider_id: input.providerId,
    display_name: input.displayName?.trim() || input.discovered?.display_name || input.modelId,
    model_id: input.modelId,
    enabled: true,
    model_type: input.discovered == null
      ? { value: "unknown", source: "unknown" }
      : { value: input.discovered.model_type.value, source: input.discovered.model_type.source },
    capabilities,
    context_window_tokens: CONSERVATIVE_CONTEXT_WINDOW_TOKENS,
    reserved_output_tokens: CONSERVATIVE_RESERVED_OUTPUT_TOKENS,
    context_capacity_source: "conservative_default",
    last_test: null,
  };
}

export interface AgentSettingsTransport {
  loadAgentLlmSettings(): Promise<AgentLlmSettingsView>;
  selectAgentChatModel(
    modelId: string,
    expectedRevision: number,
  ): Promise<AgentLlmSettingsView>;
  setAgentContextCapacity(
    request: AgentContextCapacityRequest,
  ): Promise<AgentLlmSettingsView>;
  saveProviderCredential(
    providerId: string,
    credential: string,
    confirmReplace: boolean,
  ): Promise<AgentLlmSettingsView>;
  discoverProviderModels(providerId: string): Promise<AgentModelDiscoveryResponse>;
  testProviderModel(modelId: string): Promise<AgentLlmSettingsView>;
  saveModel(model: AgentModelProfile): Promise<AgentLlmSettingsView>;
  deleteModel(modelId: string): Promise<AgentLlmSettingsView>;
  setModelContextCapacity(
    request: AgentContextCapacityRequest,
  ): Promise<AgentLlmSettingsView>;
  declareModelCapability(
    request: AgentModelCapabilityDeclarationRequest,
  ): Promise<AgentLlmSettingsView>;
  viewProviderCredential(
    providerId: string,
  ): Promise<AgentLlmCredentialRevealView>;
}

export function createTauriAgentSettingsTransport(
  invoke: AgentSettingsInvoke,
): AgentSettingsTransport {
  const commands = createAgentSettingsCommands(invoke);
  return {
    loadAgentLlmSettings: () => commands.agentLlmSettings(),
    selectAgentChatModel: (modelId, expectedRevision) => commands.agentLlmSelectModel({
      modelId,
      expectedRevision,
    }),
    setAgentContextCapacity: (request) => commands.agentLlmSetContextCapacity(request),
    saveProviderCredential: (providerId, credential, confirmReplace) =>
      commands.agentLlmSetCredential(providerId, credential, confirmReplace),
    discoverProviderModels: (providerId) => commands.agentLlmDiscoverModels(providerId),
    testProviderModel: (modelId) => commands.agentLlmTestModel(modelId),
    saveModel: (model) => commands.agentLlmSaveModel(model),
    deleteModel: (modelId) => commands.agentLlmDeleteModel({
      model_id: modelId,
      replacement_model_id: null,
    }),
    setModelContextCapacity: (request) => commands.agentLlmSetContextCapacity(request),
    declareModelCapability: (request) => commands.agentLlmDeclareModelCapability(request),
    viewProviderCredential: (providerId) =>
      commands.agentLlmViewCredential({ providerId }),
  };
}
