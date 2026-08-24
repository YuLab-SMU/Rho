import { checkedAgentTurnSummary, type AgentTurnSummary } from "./agent-conversation";
import {
  createAgentTurnCommands,
  type AgentTurnContextItem as AgentTurnContextItemWire,
  type AgentTurnDetailView as AgentTurnDetailWire,
  type AgentTurnEvent as AgentTurnEventWire,
  type AgentTurnInvoke,
  type ApprovalRequestSummary as AgentApprovalRequestWire,
} from "./generated/agent-turn";

type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer Item)[]
    ? readonly DeepReadonly<Item>[]
    : T extends object
      ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
      : T;

export type AgentTurnEvent = DeepReadonly<AgentTurnEventWire>;
export type AgentApprovalRequest = DeepReadonly<AgentApprovalRequestWire>;
export type AgentContextPlanItem = Omit<
  DeepReadonly<AgentTurnContextItemWire>,
  "context_item_id" | "turn_id" | "project_root"
>;
export type AgentTurnDetail = Omit<
  DeepReadonly<AgentTurnDetailWire>,
  "turn" | "context_items"
> & {
  readonly turn: AgentTurnSummary;
  readonly context_items: readonly AgentContextPlanItem[];
};

export interface AgentTurnDetailTransport {
  getAgentTurnDetail(turnId: string): Promise<AgentTurnDetail | null>;
}

function checkedAgentTurnDetail(detail: AgentTurnDetailWire | null): AgentTurnDetail | null {
  if (detail == null) return null;
  checkedAgentTurnSummary(detail.turn);
  return detail as AgentTurnDetail;
}

export function createTauriAgentTurnDetailTransport(
  invoke: AgentTurnInvoke,
): AgentTurnDetailTransport {
  const commands = createAgentTurnCommands(invoke);
  return {
    getAgentTurnDetail: (turnId) => commands
      .getAgentTurnDetail(turnId)
      .then(checkedAgentTurnDetail),
  };
}
