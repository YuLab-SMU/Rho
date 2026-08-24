import { describe, expect, it } from "vitest";

import {
  createTauriAgentExecutionTransport,
  type AgentApprovalDeliveryResponse,
  type AgentContextPlanPreview,
  type AgentContextPreviewRequest,
  type AgentExecutionTransport,
  type AgentTurnCancelResponse,
  type RunAgentRequest,
  type RunAgentResponse,
} from "./agent-execution";
import { createMockUiKernelTransport } from "./mock";

const runtimeOutputContext = {
  project_id: "project:fixture",
  execution_id: "runtime-execution:fixture",
  start_sequence: 1,
  end_sequence: 3,
  range_sha256: "range-sha256:fixture",
  payload_bytes: 2_048,
  chunk_count: 3,
  status: "completed",
  output_state: "complete",
} as const;

const previewRequest = {
  prompt: "Review the selected output",
  mode: "ask",
  task_kind: "agent_turn",
  model_id: null,
  editor_context: { selection: [1, 3], source: "analysis.R" },
  conversation_id: "agent-conversation:fixture",
  runtime_output_context: runtimeOutputContext,
} satisfies AgentContextPreviewRequest;

const runRequest = {
  ...previewRequest,
  auto_approve: false,
  context_plan_digest: "plan-digest:fixture",
} satisfies RunAgentRequest;

const preview = {
  plan_digest: "plan-digest:fixture",
  context_window_tokens: 128_000,
  reserved_output_tokens: 8_192,
  estimated_input_tokens: 1_024,
  capacity_source: "catalog",
  items: [{
    context_item_id: "agent-context-draft:fixture",
    ordinal: 0,
    source_kind: "current_request",
    source_id: null,
    source_revision: "1",
    source_sha256: "draft-sha256",
    trust_class: "user_instruction",
    capacity_source: "catalog",
    original_bytes: 256,
    included_bytes: 256,
    estimated_tokens: 64,
    disposition: "complete",
    reason_code: null,
  }],
  model_profile_id: "model-profile:fixture",
  model_display_name: "Fixture model",
  settings_revision: 9,
  conversation_id: previewRequest.conversation_id,
  runtime_output_context: runtimeOutputContext,
} satisfies AgentContextPlanPreview;

const started = {
  status: "started",
  turn_id: "agent-turn:fixture",
  conversation_id: previewRequest.conversation_id,
  retry_of_turn_id: null,
  auto_approve: false,
  task_kind: "agent_turn",
} satisfies RunAgentResponse;

const cancelled = {
  status: "cancelled",
  turn_id: started.turn_id,
} satisfies AgentTurnCancelResponse;

const delivered = {
  status: "delivered",
  request_id: "agent-request:fixture",
  turn_id: started.turn_id,
} satisfies AgentApprovalDeliveryResponse;

describe("Agent context and turn-control generated transport", () => {
  it("owns all five command identities and preserves exact flat arguments", async () => {
    const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
    const transport = createTauriAgentExecutionTransport(
      async <T,>(command: string, args?: Record<string, unknown>): Promise<T> => {
        calls.push({ command, ...(args === undefined ? {} : { args }) });
        if (command === "agent_context_preview") return preview as T;
        if (command === "cancel_agent_turn") return cancelled as T;
        if (command === "respond_approval") return delivered as T;
        return started as T;
      },
    );
    const decision = {
      request_id: delivered.request_id,
      decision: "approve",
      reason: null,
    } as const;

    await transport.previewAgentContext(previewRequest);
    await transport.runAgent(runRequest);
    await transport.retryAgentTurn(started.turn_id);
    await transport.cancelAgentTurn(started.turn_id);
    await transport.respondAgentApproval(decision);

    expect(calls).toEqual([{
      command: "agent_context_preview",
      args: {
        prompt: previewRequest.prompt,
        mode: previewRequest.mode,
        taskKind: previewRequest.task_kind,
        modelId: previewRequest.model_id,
        editorContext: previewRequest.editor_context,
        conversationId: previewRequest.conversation_id,
        runtimeOutputContext: previewRequest.runtime_output_context,
      },
    }, {
      command: "run_agent",
      args: {
        prompt: runRequest.prompt,
        mode: runRequest.mode,
        taskKind: runRequest.task_kind,
        modelId: runRequest.model_id,
        autoApprove: runRequest.auto_approve,
        editorContext: runRequest.editor_context,
        conversationId: runRequest.conversation_id,
        runtimeOutputContext: runRequest.runtime_output_context,
        contextPlanDigest: runRequest.context_plan_digest,
      },
    }, {
      command: "retry_agent_turn",
      args: { turnId: started.turn_id },
    }, {
      command: "cancel_agent_turn",
      args: { turnId: started.turn_id },
    }, {
      command: "respond_approval",
      args: { request: decision },
    }]);
  });

  it("preserves backend rejection without broadening the facet", async () => {
    const transport = createTauriAgentExecutionTransport(async () => {
      throw new Error("Agent context changed after review");
    });
    await expect(transport.runAgent(runRequest)).rejects.toThrow("changed after review");
  });

  it("keeps browser/mock mode assignable to the narrow execution facet", async () => {
    const transport: AgentExecutionTransport = createMockUiKernelTransport();
    await expect(transport.previewAgentContext({
      ...previewRequest,
      editor_context: null,
      runtime_output_context: null,
    })).resolves.toMatchObject({ conversation_id: previewRequest.conversation_id });
  });
});
