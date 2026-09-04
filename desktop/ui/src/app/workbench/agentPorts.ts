import type { UiKernelTransport } from "../../transport";

export type AgentCorePorts = Pick<
  UiKernelTransport,
  | "cancelAgentTurn"
  | "getAgentTurnDetail"
  | "listAgentConversations"
  | "listAgentTurns"
  | "retryAgentRuntime"
  | "subscribeAgentInvalidated"
  | "subscribeAgentTurnEvents"
>;

const cache = new WeakMap<object, AgentCorePorts>();

export function createAgentCorePorts(source: AgentCorePorts): AgentCorePorts {
  const cached = cache.get(source as object);
  if (cached != null) return cached;
  const ports: AgentCorePorts = {
    cancelAgentTurn: (turnId) => source.cancelAgentTurn(turnId),
    getAgentTurnDetail: (turnId) => source.getAgentTurnDetail(turnId),
    listAgentConversations: (limit) => source.listAgentConversations(limit),
    listAgentTurns: (conversationId, limit) => source.listAgentTurns(conversationId, limit),
    retryAgentRuntime: () => source.retryAgentRuntime(),
    subscribeAgentInvalidated: (listener) => source.subscribeAgentInvalidated(listener),
    subscribeAgentTurnEvents: (listener) => source.subscribeAgentTurnEvents(listener),
  };
  cache.set(source as object, ports);
  return ports;
}
