import {
  createAgentSettingsCommands,
  type AgentContextCapacityRequest as AgentContextCapacityRequestWire,
  type AgentLlmSettingsView as AgentLlmSettingsViewWire,
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
export type AgentContextCapacityRequest = DeepReadonly<AgentContextCapacityRequestWire>;

export interface AgentSettingsTransport {
  loadAgentLlmSettings(): Promise<AgentLlmSettingsView>;
  selectAgentChatModel(
    modelId: string,
    expectedRevision: number,
  ): Promise<AgentLlmSettingsView>;
  setAgentContextCapacity(
    request: AgentContextCapacityRequest,
  ): Promise<AgentLlmSettingsView>;
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
  };
}
