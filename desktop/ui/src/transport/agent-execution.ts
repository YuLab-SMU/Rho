import type { AgentMode } from "./agent-conversation";
import {
  createAgentExecutionCommands,
  type AgentApprovalDeliveryResponse as AgentApprovalDeliveryResponseWire,
  type AgentContextPlanPreviewView as AgentContextPlanPreviewWire,
  type AgentExecutionInvoke,
  type AgentJsonValue,
  type AgentTurnCancelResponse as AgentTurnCancelResponseWire,
  type AgentTurnStartResponse as AgentTurnStartResponseWire,
  type ApprovalDecisionRequest as AgentApprovalDecisionRequestWire,
} from "./generated/agent-execution";
import type { RuntimeOutputReference } from "./runtime-output";

type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer Item)[]
    ? readonly DeepReadonly<Item>[]
    : T extends object
      ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
      : T;

type AgentExecutionCommands = ReturnType<typeof createAgentExecutionCommands>;
type AgentContextPreviewArguments = Parameters<AgentExecutionCommands["agentContextPreview"]>;
type RunAgentArguments = Parameters<AgentExecutionCommands["runAgent"]>;

export type AgentTaskKind = "agent_turn" | "problem_repair";
export type AgentEditorContext = AgentJsonValue;

export type AgentContextPreviewRequest = Readonly<{
  prompt: AgentContextPreviewArguments[0];
  mode: AgentMode;
  task_kind: AgentTaskKind;
  model_id: AgentContextPreviewArguments[3];
  editor_context: AgentEditorContext | null;
  conversation_id: AgentContextPreviewArguments[5];
  runtime_output_context: RuntimeOutputReference | null;
}>;

export type AgentContextPlanPreview = DeepReadonly<AgentContextPlanPreviewWire>;

export type RunAgentRequest = Readonly<{
  prompt: RunAgentArguments[0];
  mode: AgentMode;
  task_kind: AgentTaskKind;
  model_id: RunAgentArguments[3];
  auto_approve: NonNullable<RunAgentArguments[4]>;
  editor_context: AgentEditorContext | null;
  conversation_id: RunAgentArguments[6];
  runtime_output_context: RuntimeOutputReference | null;
  context_plan_digest: RunAgentArguments[8];
}>;

export type RunAgentResponse = DeepReadonly<AgentTurnStartResponseWire>;
export type AgentTurnCancelResponse = DeepReadonly<AgentTurnCancelResponseWire>;
export type AgentApprovalDeliveryResponse = DeepReadonly<AgentApprovalDeliveryResponseWire>;
export type AgentApprovalDecisionRequest = Omit<
  DeepReadonly<AgentApprovalDecisionRequestWire>,
  "decision"
> & {
  readonly decision: "approve" | "reject" | "cancel";
};

export interface AgentExecutionTransport {
  previewAgentContext(request: AgentContextPreviewRequest): Promise<AgentContextPlanPreview>;
  runAgent(request: RunAgentRequest): Promise<RunAgentResponse>;
  retryAgentTurn(turnId: string): Promise<RunAgentResponse>;
  cancelAgentTurn(turnId: string): Promise<AgentTurnCancelResponse>;
  respondAgentApproval(
    request: AgentApprovalDecisionRequest,
  ): Promise<AgentApprovalDeliveryResponse>;
}

export function createTauriAgentExecutionTransport(
  invoke: AgentExecutionInvoke,
): AgentExecutionTransport {
  const commands = createAgentExecutionCommands(invoke);
  return {
    previewAgentContext: (request) => commands.agentContextPreview(
      request.prompt,
      request.mode,
      request.task_kind,
      request.model_id,
      request.editor_context,
      request.conversation_id,
      request.runtime_output_context,
    ),
    runAgent: (request) => commands.runAgent(
      request.prompt,
      request.mode,
      request.task_kind,
      request.model_id,
      request.auto_approve,
      request.editor_context,
      request.conversation_id,
      request.runtime_output_context,
      request.context_plan_digest,
    ),
    retryAgentTurn: (turnId) => commands.retryAgentTurn(turnId),
    cancelAgentTurn: (turnId) => commands.cancelAgentTurn(turnId),
    respondAgentApproval: (request) => commands.respondApproval(request),
  };
}
