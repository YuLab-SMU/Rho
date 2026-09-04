import {
  createAgentConversationCommands,
  type AgentConversationInvoke,
  type AgentConversationSummary as AgentConversationSummaryWire,
  type AgentTurnSummary as AgentTurnSummaryWire,
} from "./generated/agent-conversation";

type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer Item)[]
    ? readonly DeepReadonly<Item>[]
    : T extends object
      ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
      : T;

export type AgentConversationSummary = DeepReadonly<AgentConversationSummaryWire>;
export type AgentTurnSummary = DeepReadonly<AgentTurnSummaryWire>;

export interface AgentConversationTransport {
  listAgentConversations(limit?: number): Promise<readonly AgentConversationSummary[]>;
  createAgentConversation(): Promise<AgentConversationSummary>;
  listAgentTurns(
    conversationId: string | null,
    limit?: number,
  ): Promise<readonly AgentTurnSummary[]>;
}

export function checkedAgentTurnSummary(turn: AgentTurnSummaryWire): AgentTurnSummary {
  return turn as AgentTurnSummary;
}

export function createTauriAgentConversationTransport(
  invoke: AgentConversationInvoke,
): AgentConversationTransport {
  const commands = createAgentConversationCommands(invoke);
  return {
    listAgentConversations: (limit = 50) => commands.listAgentConversations(limit),
    createAgentConversation: () => commands.createAgentConversation(),
    listAgentTurns: (conversationId, limit = 50) => commands
      .listAgentTurns(conversationId, limit)
      .then((turns) => turns.map(checkedAgentTurnSummary)),
  };
}
