import type { UiKernelTransport } from "../../transport";
import type { EnvironmentHealthView } from "../../transport/environment";
import type { Unsubscribe } from "../../transport/types";

export interface AgentEnvironmentPort {
  environmentHealth(): Promise<EnvironmentHealthView>;
  subscribeInvalidated(listener: () => void): Unsubscribe;
}

export type AgentCorePorts = Pick<
  UiKernelTransport,
  | "cancelAgentTurn"
  | "getAgentRuntimeDiagnostics"
  | "getAgentTurnDetail"
  | "listAgentConversations"
  | "listAgentTurns"
  | "loadResources"
  | "previewAgentContext"
  | "readResource"
  | "resolveResource"
  | "respondAgentApproval"
  | "retryAgentRuntime"
  | "retryAgentTurn"
  | "subscribeAgentInvalidated"
  | "subscribeAgentTurnEvents"
  | "subscribeResourcesInvalidated"
>;

const cache = new WeakMap<object, AgentCorePorts>();

export function createAgentCorePorts(source: AgentCorePorts): AgentCorePorts {
  const cached = cache.get(source as object);
  if (cached != null) return cached;
  const ports: AgentCorePorts = {
    cancelAgentTurn: (turnId) => source.cancelAgentTurn(turnId),
    getAgentRuntimeDiagnostics: () => source.getAgentRuntimeDiagnostics(),
    getAgentTurnDetail: (turnId) => source.getAgentTurnDetail(turnId),
    listAgentConversations: () => source.listAgentConversations(),
    listAgentTurns: (conversationId) => source.listAgentTurns(conversationId),
    loadResources: () => source.loadResources(),
    previewAgentContext: (request) => source.previewAgentContext(request),
    readResource: (request) => source.readResource(request),
    resolveResource: (request) => source.resolveResource(request),
    respondAgentApproval: (request) => source.respondAgentApproval(request),
    retryAgentRuntime: () => source.retryAgentRuntime(),
    retryAgentTurn: (turnId) => source.retryAgentTurn(turnId),
    subscribeAgentInvalidated: (listener) => source.subscribeAgentInvalidated(listener),
    subscribeAgentTurnEvents: (listener) => source.subscribeAgentTurnEvents(listener),
    subscribeResourcesInvalidated: (listener) => source.subscribeResourcesInvalidated(listener),
  };
  cache.set(source as object, ports);
  return ports;
}
