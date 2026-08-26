import { describe, expect, it } from "vitest";

import type {
  AgentConversationSummary,
  AgentTurnDetail,
  AgentTurnEvent,
  AgentTurnSummary,
} from "../../../transport";
import {
  conversationHasExactReference,
  projectExplorationActivities,
  projectExplorationConversation,
  projectExplorationStatus,
  projectExplorationTurn,
} from "./exploration-model";

const NOW = "2026-08-27T10:00:00Z";

function conversation(
  overrides: Partial<AgentConversationSummary> = {},
): AgentConversationSummary {
  return {
    conversation_id: "conversation:one",
    project_root: "/projects/rho",
    title: "Compare cluster 3 and cluster 7 with donor-aware analysis",
    created_at: NOW,
    updated_at: NOW,
    archived_at: null,
    legacy_unthreaded: false,
    turn_count: 1,
    status: "completed",
    latest_turn_id: "turn:one",
    latest_mode: "act",
    latest_prompt_preview: "Check donor-level consistency.",
    terminal_reason: null,
    pending_request_id: null,
    ...overrides,
  };
}

function turn(overrides: Partial<AgentTurnSummary> = {}): AgentTurnSummary {
  return {
    turn_id: "turn:one",
    conversation_id: "conversation:one",
    project_root: "/projects/rho",
    mode: "act",
    status: "completed",
    started_at: NOW,
    finished_at: NOW,
    prompt_preview: "Check donor-level consistency.",
    model: "provider/private-model",
    workspace_id_before: "workspace:one",
    state_revision_before: 4,
    project_revision_before: 7,
    workspace_id_after: "workspace:one",
    state_revision_after: 5,
    project_revision_after: 8,
    final_message: "The donor-level run finished; review its recorded output separately.",
    error_message: null,
    pending_request_id: null,
    retry_of_turn_id: null,
    terminal_reason: null,
    ...overrides,
  };
}

function event(
  id: number,
  eventType: string,
  overrides: Partial<AgentTurnEvent> = {},
): AgentTurnEvent {
  return {
    id,
    turn_id: "turn:one",
    timestamp: NOW,
    event_type: eventType,
    title: `Event ${id}`,
    body: `Public body ${id}`,
    status: "completed",
    tool: null,
    request_id: null,
    code: null,
    details_json: JSON.stringify({ private_reasoning: `hidden-${id}` }),
    ...overrides,
  };
}

function detail(
  summary: AgentTurnSummary,
  events: readonly AgentTurnEvent[],
): AgentTurnDetail {
  return {
    turn: summary,
    events,
    approvals: [],
    context_items: [],
  };
}

describe("Vibe exploration truth projection", () => {
  it("keeps durable interruption reasons distinct and tolerates mock-only cancelled", () => {
    expect(projectExplorationStatus("running", null)).toMatchObject({ kind: "running", active: true });
    expect(projectExplorationStatus("waiting", null)).toMatchObject({ kind: "waiting", active: true });
    expect(projectExplorationStatus("completed", null)).toMatchObject({ kind: "completed", retryable: false });
    expect(projectExplorationStatus("failed", "agent_failure")).toMatchObject({ kind: "failed", retryable: true });
    expect(projectExplorationStatus("interrupted", "user_cancelled")).toMatchObject({ kind: "cancelled", label: "已取消" });
    expect(projectExplorationStatus("interrupted", "desktop_restart")).toMatchObject({ kind: "interrupted", label: "已中断" });
    expect(projectExplorationStatus("cancelled", "user_cancelled")).toMatchObject({ kind: "cancelled" });
    expect(projectExplorationStatus("invented", null)).toMatchObject({ kind: "unknown", active: false, retryable: false });
  });

  it("projects only public event summaries in durable event order", () => {
    const activities = projectExplorationActivities([
      event(4, "tool.call_failed", { title: "R command failed", code: "stop('fit failed')" }),
      event(2, "agent.user_prompt", { body: "private user request" }),
      event(3, "tool.call_started", { title: "Run donor aggregation" }),
      event(1, "agent.plugin_context", { body: "untrusted plugin payload" }),
    ]);

    expect(activities.map((activity) => activity.title)).toEqual([
      "Run donor aggregation",
      "R command failed",
    ]);
    expect(activities.map((activity) => activity.kind)).toEqual(["execution", "attention"]);
    expect(activities[1]?.code).toBe("stop('fit failed')");
    expect(JSON.stringify(activities)).not.toContain("private_reasoning");
    expect(JSON.stringify(activities)).not.toContain("untrusted plugin payload");
  });

  it("uses the immutable public prompt as task without upgrading the final reply", () => {
    const summary = turn();
    const projected = projectExplorationTurn(summary, detail(summary, [
      event(1, "agent.user_prompt", {
        title: "You",
        body: "Use donor-level pseudobulk and report any execution limitation.",
      }),
      event(2, "tool.call_completed", { title: "Aggregation completed" }),
    ]));

    expect(projected.task).toBe("Use donor-level pseudobulk and report any execution limitation.");
    expect(projected.finalMessage).toBe(summary.final_message);
    expect(projected.activities).toHaveLength(1);
    expect(projected).not.toHaveProperty("route");
    expect(projected).not.toHaveProperty("observation");
    expect(projected).not.toHaveProperty("candidate");
    expect(projected).not.toHaveProperty("conclusion");
  });

  it("falls back to the Turn summary when detail is absent or mismatched", () => {
    const summary = turn({ prompt_preview: "A bounded summary task" });
    const mismatch = detail(turn({ turn_id: "turn:other" }), [
      event(1, "agent.user_prompt", { turn_id: "turn:other", body: "Wrong Turn" }),
    ]);

    expect(projectExplorationTurn(summary, null)).toMatchObject({
      task: "A bounded summary task",
      detailAvailable: false,
      activities: [],
    });
    expect(projectExplorationTurn(summary, mismatch)).toMatchObject({
      task: "A bounded summary task",
      detailAvailable: false,
      activities: [],
    });
  });

  it("derives attention and exact-reference markers only from exact fields", () => {
    const summary = turn({ status: "waiting", pending_request_id: "approval:one" });
    const projectedTurn = projectExplorationTurn(summary, detail(summary, []));
    const projectedConversation = projectExplorationConversation(conversation({
      status: "waiting",
      pending_request_id: "approval:one",
    }));

    expect(projectedTurn.needsAttention).toBe(true);
    expect(projectedConversation.needsAttention).toBe(true);
    expect(conversationHasExactReference(
      "conversation:one",
      [projectedTurn],
      [],
      ["turn:one"],
    )).toBe(true);
    expect(conversationHasExactReference(
      "conversation:one",
      [projectedTurn],
      [],
      ["similar-looking-turn"],
    )).toBe(false);
    expect(conversationHasExactReference(
      "conversation:one",
      [],
      ["conversation:one"],
      [],
    )).toBe(true);
  });
});
