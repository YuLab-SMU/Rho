import { describe, expect, it } from "vitest";

import {
  createTauriAgentConversationTransport,
  type AgentConversationSummary,
  type AgentConversationTransport,
  type AgentTurnSummary,
} from "./agent-conversation";
import { createMockUiKernelTransport } from "./mock";

const conversation = {
  conversation_id: "agent-conversation:fixture",
  project_root: "/tmp/Project A",
  title: "Model review",
  created_at: "2026-08-24T12:00:00Z",
  updated_at: "2026-08-24T12:01:00Z",
  archived_at: null,
  legacy_unthreaded: false,
  turn_count: 1,
  status: "completed",
  latest_turn_id: "agent-turn:1",
  latest_prompt_preview: "Review the model",
  terminal_reason: "completed",
} satisfies AgentConversationSummary;

const turn = {
  turn_id: "agent-turn:1",
  conversation_id: conversation.conversation_id,
  project_root: conversation.project_root,
  status: "completed",
  started_at: conversation.created_at,
  finished_at: conversation.updated_at,
  prompt_preview: "Review the model",
  model: "model:fixture",
  workspace_id_before: "workspace:a",
  state_revision_before: 5,
  project_revision_before: 7,
  workspace_id_after: "workspace:a",
  state_revision_after: 6,
  project_revision_after: 7,
  final_message: "Looks sound.",
  error_message: null,
  retry_of_turn_id: null,
  terminal_reason: "completed",
} satisfies AgentTurnSummary;

describe("Agent conversation generated transport", () => {
  it("owns all three command identities and preserves defaults and camel-case args", async () => {
    const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
    const invoke = async <T,>(command: string, args?: Record<string, unknown>): Promise<T> => {
      calls.push({ command, ...(args === undefined ? {} : { args }) });
      return (command === "create_agent_conversation"
        ? conversation
        : command === "list_agent_turns"
          ? [turn]
          : [conversation]) as T;
    };
    const transport = createTauriAgentConversationTransport(invoke);

    await transport.listAgentConversations();
    await transport.createAgentConversation();
    await transport.listAgentTurns(conversation.conversation_id);

    expect(calls).toEqual([
      { command: "list_agent_conversations", args: { limit: 50 } },
      { command: "create_agent_conversation" },
      {
        command: "list_agent_turns",
        args: { conversationId: conversation.conversation_id, limit: 50 },
      },
    ]);
  });

  it("preserves backend rejection", async () => {
    const rejected = createTauriAgentConversationTransport(async () => {
      throw new Error("Agent Conversation belongs to another project");
    });
    await expect(rejected.listAgentConversations(10)).rejects.toThrow("another project");

  });

  it("keeps browser/mock mode assignable to the narrow conversation facet", async () => {
    const transport: AgentConversationTransport = createMockUiKernelTransport();
    await expect(transport.listAgentConversations(1)).resolves.toHaveLength(1);
  });
});
