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
    latest_prompt_preview: "Check donor-level consistency.",
    terminal_reason: null,
    ...overrides,
  };
}

function turn(overrides: Partial<AgentTurnSummary> = {}): AgentTurnSummary {
  return {
    turn_id: "turn:one",
    conversation_id: "conversation:one",
    project_root: "/projects/rho",
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
      event(3, "tool.call_started", {
        title: "Run donor aggregation",
        code: "aggregate_by_donor()",
      }),
      event(1, "agent.plugin_context", { body: "untrusted plugin payload" }),
    ]);

    expect(activities.map((activity) => activity.title)).toEqual([
      "Run donor aggregation",
      "R command failed",
    ]);
    expect(activities.map((activity) => activity.kind)).toEqual(["execution", "attention"]);
    expect(activities[0]?.code).toBe("aggregate_by_donor()");
    expect(activities[1]?.code).toBeNull();
    expect(JSON.stringify(activities)).not.toContain("private_reasoning");
    expect(JSON.stringify(activities)).not.toContain("untrusted plugin payload");
  });

  it("redacts every public failure field and fails closed for rejected implementation code", () => {
    const activities = projectExplorationActivities([
      event(1, "tool.call_failed", {
        title: "R command failed for resource:abc123 at s3://private-bucket/run-7",
        body: "{\"conversation_id\":\"opaque-secret-7\",\"password\":\"hunter2\"," +
          "\"path\":\"/研究/李 四/私密/model.R\"}",
        status: "failed {\"profile_id\":\"opaque-secret-9\"}",
        code: "source('/Users/alice/private/rho/secret.R'); api_key <- 'sk-local-only'",
      }),
      event(2, "desktop.agent_failed", {
        title: "Model fit failed",
        body: "One donor had no usable cells; the recorded fit stopped.",
        status: "failed",
        code: null,
      }),
      event(3, "agent.interrupted", {
        title: "Interrupted resource:abc123",
        body: "State remained at \\\\研究服务器\\共享 数据\\李 四\\结果.csv for profile:abc123.",
        status: "interrupted",
        code: "resume_internal_state()",
      }),
      event(4, "agent.cancelled", {
        title: "Cancelled request:private-4",
        body: "The user cancelled this run.",
        status: "cancelled",
        code: "cancel_internal_state()",
      }),
    ]);

    expect(activities[0]).toMatchObject({
      title: "R command failed for [internal reference] at [internal reference]",
      status: "failed {[internal reference]}",
      code: null,
    });
    expect(activities[0]?.body).toContain("[internal reference]");
    expect(activities[0]?.body).toContain("[secret]");
    expect(activities[0]?.body).toContain("[local path]");
    expect(JSON.stringify(activities[0])).not.toContain("/Users/alice");
    expect(JSON.stringify(activities[0])).not.toContain("opaque-secret-7");
    expect(JSON.stringify(activities[0])).not.toContain("opaque-secret-9");
    expect(JSON.stringify(activities[0])).not.toContain("hunter2");
    expect(JSON.stringify(activities[0])).not.toContain("李 四");
    expect(JSON.stringify(activities[0])).not.toContain("private-bucket");
    expect(JSON.stringify(activities[0])).not.toContain("sk-local-only");
    expect(activities[1]).toMatchObject({
      title: "Model fit failed",
      body: "One donor had no usable cells; the recorded fit stopped.",
      status: "failed",
      code: null,
    });
    expect(activities[2]).toMatchObject({
      title: "Interrupted [internal reference]",
      body: "State remained at [local path] for [internal reference].",
      status: "interrupted",
      code: null,
    });
    expect(activities[3]).toMatchObject({
      title: "Cancelled [internal reference]",
      body: "The user cancelled this run.",
      status: "cancelled",
      code: null,
    });
    expect(JSON.stringify(activities)).not.toContain("resume_internal_state");
    expect(JSON.stringify(activities)).not.toContain("cancel_internal_state");
  });

  it("reduces a trusted file proposal payload to a public fact without exposing its mutation content", () => {
    const activities = projectExplorationActivities([
      event(1, "tool.call_completed", {
        title: "Proposed file edit",
        tool: "propose_file_edit",
        body: JSON.stringify({
          kind: "rho.file_edit_proposal",
          operation: "append",
          path: "private-analysis.R",
          content: "secret mutation content",
        }),
      }),
    ]);

    expect(activities).toHaveLength(1);
    expect(activities[0]?.body).toBe(
      "Agent 记录了一项文件修改建议；修改内容和应用操作仅在 Studio 中检查。",
    );
    expect(JSON.stringify(activities)).not.toContain("private-analysis.R");
    expect(JSON.stringify(activities)).not.toContain("secret mutation content");
  });

  it("fails closed for oversized or malformed structured proposal activity", () => {
    const oversized = projectExplorationActivities([
      event(1, "tool.call_completed", {
        title: "Proposed file edit",
        tool: "propose_file_edit",
        body: JSON.stringify({
          kind: "rho.file_edit_proposal",
          path: "private-analysis.R",
          content: "secret".repeat(30_000),
        }),
      }),
    ]);
    const malformed = projectExplorationActivities([
      event(2, "tool.call_completed", {
        title: "Structured activity",
        body: "{\"kind\":\"rho.file_edit_proposal\",\"content\":\"secret",
      }),
    ]);

    expect(oversized[0]?.body).toContain("文件修改建议");
    expect(JSON.stringify(oversized)).not.toContain("private-analysis.R");
    expect(JSON.stringify(oversized)).not.toContain("secretsecret");
    expect(malformed[0]?.body).toContain("格式不可用");
    expect(JSON.stringify(malformed)).not.toContain("secret");
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

  it("redacts a persisted Agent failure only in the Vibe projection", () => {
    const persistedError = "Failed at /Users/alice/private/rho/model.R for turn_id=turn:internal-77.";
    const summary = turn({
      status: "failed",
      error_message: persistedError,
      final_message: "A public final response remains primary content.",
    });
    const projected = projectExplorationTurn(summary, detail(summary, []));

    expect(projected.errorMessage).toContain("Failed at [local path]");
    expect(projected.errorMessage).toContain("[internal reference]");
    expect(projected.errorMessage).not.toContain("turn:internal-77");
    expect(projected.finalMessage).toBe(summary.final_message);
    expect(summary.error_message).toBe(persistedError);
  });

  it("derives attention and exact-reference markers only from exact fields", () => {
    const summary = turn({ status: "failed" });
    const projectedTurn = projectExplorationTurn(summary, detail(summary, []));
    const projectedConversation = projectExplorationConversation(conversation({
      status: "failed",
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
