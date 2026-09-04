import { describe, expect, it } from "vitest";

import {
  createTauriAgentExecutionTransport,
  type AgentExecutionTransport,
  type AgentTurnCancelResponse,
  type RunAgentRequest,
  type RunAgentResponse,
} from "./agent-execution";
import { createMockUiKernelTransport } from "./mock";

const runRequest = {
  prompt: "Review the selected output",
  conversation_id: "agent-conversation:fixture",
} satisfies RunAgentRequest;

const started = {
  status: "started",
  turn_id: "agent-turn:fixture",
  conversation_id: runRequest.conversation_id,
  retry_of_turn_id: null,
} satisfies RunAgentResponse;

const cancelled = {
  status: "cancelled",
  turn_id: started.turn_id,
} satisfies AgentTurnCancelResponse;

describe("External Agent turn-control generated transport", () => {
  it("owns all three command identities and preserves exact flat arguments", async () => {
    const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
    const transport = createTauriAgentExecutionTransport(
      async <T,>(command: string, args?: Record<string, unknown>): Promise<T> => {
        calls.push({ command, ...(args === undefined ? {} : { args }) });
        return (command === "cancel_agent_turn" ? cancelled : started) as T;
      },
    );

    await transport.runAgent(runRequest);
    await transport.retryAgentTurn(started.turn_id);
    await transport.cancelAgentTurn(started.turn_id);

    expect(calls).toEqual([{
      command: "run_agent",
      args: {
        prompt: runRequest.prompt,
        conversationId: runRequest.conversation_id,
      },
    }, {
      command: "retry_agent_turn",
      args: { turnId: started.turn_id },
    }, {
      command: "cancel_agent_turn",
      args: { turnId: started.turn_id },
    }]);
  });

  it("preserves backend rejection without broadening the facet", async () => {
    const transport = createTauriAgentExecutionTransport(async () => {
      throw new Error("External ACP Agent is unavailable");
    });
    await expect(transport.runAgent(runRequest)).rejects.toThrow("unavailable");
  });

  it("keeps browser/mock mode assignable to the narrow execution facet", async () => {
    const transport: AgentExecutionTransport = createMockUiKernelTransport();
    await expect(transport.runAgent(runRequest))
      .resolves.toMatchObject({ conversation_id: runRequest.conversation_id });
  });
});
