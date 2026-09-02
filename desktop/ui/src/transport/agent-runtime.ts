import {
  createAgentRuntimeCommands,
  type AgentRuntimeInvoke,
  type AgentRuntimeStatusView as AgentRuntimeStatusWire,
} from "./generated/agent-runtime";

type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer Item)[]
    ? readonly DeepReadonly<Item>[]
    : T extends object
      ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
      : T;

export type AgentRuntimeDiagnostics = DeepReadonly<AgentRuntimeStatusWire>;

export interface AgentRuntimeTransport {
  getAgentRuntimeDiagnostics(): Promise<AgentRuntimeDiagnostics>;
  retryAgentRuntime(): Promise<AgentRuntimeDiagnostics>;
}

export function createTauriAgentRuntimeTransport(
  invoke: AgentRuntimeInvoke,
): AgentRuntimeTransport {
  const commands = createAgentRuntimeCommands(invoke);
  return {
    getAgentRuntimeDiagnostics: () => commands.agentRuntimeStatus(),
    retryAgentRuntime: () => commands.agentRuntimeRetry(),
  };
}
