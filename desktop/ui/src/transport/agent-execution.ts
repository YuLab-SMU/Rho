import {
  createAgentExecutionCommands,
  type AgentExecutionInvoke,
  type AgentTurnCancelResponse as AgentTurnCancelResponseWire,
  type AgentTurnStartResponse as AgentTurnStartResponseWire,
} from "./generated/agent-execution";

type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer Item)[]
    ? readonly DeepReadonly<Item>[]
    : T extends object
      ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
      : T;

type AgentExecutionCommands = ReturnType<typeof createAgentExecutionCommands>;
type RunAgentArguments = Parameters<AgentExecutionCommands["runAgent"]>;

export type RunAgentRequest = Readonly<{
  prompt: RunAgentArguments[0];
  conversation_id: RunAgentArguments[1];
}>;

export type RunAgentResponse = DeepReadonly<AgentTurnStartResponseWire>;
export type AgentTurnCancelResponse = DeepReadonly<AgentTurnCancelResponseWire>;

export interface AgentExecutionTransport {
  runAgent(request: RunAgentRequest): Promise<RunAgentResponse>;
  retryAgentTurn(turnId: string): Promise<RunAgentResponse>;
  cancelAgentTurn(turnId: string): Promise<AgentTurnCancelResponse>;
}

export function createTauriAgentExecutionTransport(
  invoke: AgentExecutionInvoke,
): AgentExecutionTransport {
  const commands = createAgentExecutionCommands(invoke);
  return {
    runAgent: (request) => commands.runAgent(
      request.prompt,
      request.conversation_id,
    ),
    retryAgentTurn: (turnId) => commands.retryAgentTurn(turnId),
    cancelAgentTurn: (turnId) => commands.cancelAgentTurn(turnId),
  };
}
