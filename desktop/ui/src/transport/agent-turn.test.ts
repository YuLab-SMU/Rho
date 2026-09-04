import { describe, expect, it } from "vitest";

import type { AgentTurnSummary } from "./agent-conversation";
import {
  createTauriAgentTurnDetailTransport,
  type AgentTurnDetail,
  type AgentTurnDetailTransport,
} from "./agent-turn";
import { createMockUiKernelTransport } from "./mock";

const turn = {
  turn_id: "agent-turn:fixture",
  conversation_id: "agent-conversation:fixture",
  project_root: "/tmp/Project A",
  status: "completed",
  started_at: "2026-08-24T12:00:00Z",
  finished_at: "2026-08-24T12:01:00Z",
  prompt_preview: "Review the model",
  model: "external-acp",
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

const detail = {
  turn,
  events: [{
    id: 42,
    turn_id: turn.turn_id,
    timestamp: "2026-08-24T12:00:30Z",
    event_type: "tool.call_completed",
    title: "Inspected model",
    body: "Model structure is consistent.",
    status: "completed",
    tool: "inspect_model",
    request_id: "agent-request:fixture",
    code: null,
    details_json: "{\"success\":true}",
  }],
} satisfies AgentTurnDetail;

describe("External Agent turn detail generated transport", () => {
  it("owns the command identity and preserves the camel-case argument", async () => {
    const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
    const transport = createTauriAgentTurnDetailTransport(
      async <T,>(command: string, args?: Record<string, unknown>): Promise<T> => {
        calls.push({ command, ...(args === undefined ? {} : { args }) });
        return detail as T;
      },
    );

    await expect(transport.getAgentTurnDetail(turn.turn_id)).resolves.toEqual(detail);
    expect(calls).toEqual([{
      command: "get_agent_turn_detail",
      args: { turnId: turn.turn_id },
    }]);
  });

  it("preserves null and backend rejection", async () => {
    const missing = createTauriAgentTurnDetailTransport(async <T,>() => null as T);
    await expect(missing.getAgentTurnDetail("agent-turn:missing")).resolves.toBeNull();

    const rejected = createTauriAgentTurnDetailTransport(async () => {
      throw new Error("Agent Turn belongs to another project");
    });
    await expect(rejected.getAgentTurnDetail(turn.turn_id)).rejects.toThrow("another project");

  });

  it("keeps browser/mock mode assignable to the narrow turn-detail facet", async () => {
    const transport: AgentTurnDetailTransport = createMockUiKernelTransport();
    await expect(transport.getAgentTurnDetail("agent-turn:mock-1"))
      .resolves.toMatchObject({ turn: { status: "completed" } });
  });
});
