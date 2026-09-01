import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AgentTurnDetail } from "../../transport";
import { AgentActivity } from "./AgentActivity";
import { AgentApprovalPanel } from "./AgentApprovalPanel";
import { AgentCurrentWork } from "./AgentCurrentWork";
import { AgentFinalAnswer } from "./AgentFinalAnswer";
import { AgentGoal } from "./AgentGoal";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

describe("Agent semantic sections", () => {
  const roots: Array<ReturnType<typeof createRoot>> = [];

  afterEach(() => {
    for (const root of roots.splice(0)) act(() => root.unmount());
    document.body.replaceChildren();
  });

  it("renders Goal, Current Work, Activity, Approvals and Final Answer independently", () => {
    const approval: AgentTurnDetail["approvals"][number] = {
      request_id: "approval:1",
      turn_id: "turn:1",
      project_root: "/mock/project",
      tool: "write_project_file",
      policy: "exact_effect",
      code: null,
      arguments_json: "{}",
      status: "waiting",
      requested_at: "2026-09-01T00:00:00Z",
      responded_at: null,
      decision: null,
      reason: null,
      workspace_id: "workspace:mock",
      state_revision: 3,
      project_revision: 4,
      continuation_outcome: null,
    };
    const onDecision = vi.fn();
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    roots.push(root);
    act(() => root.render(<>
      <AgentGoal prompt="Verify the model" />
      <AgentCurrentWork prompt="Run robustness checks" turnCount={2} />
      <AgentActivity events={[]} contextItems={[]} />
      <AgentApprovalPanel approvals={[approval]} disabled={false} onDecision={onDecision} />
      <AgentFinalAnswer answer="The result remains provisional." />
    </>));

    expect(host.textContent).toContain("Goal");
    expect(host.textContent).toContain("Current Work");
    expect(host.textContent).toContain("Approvals");
    expect(host.textContent).toContain("Final Answer");
    const approve = [...host.querySelectorAll("button")]
      .find((button) => button.textContent === "Approve")!;
    act(() => approve.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(onDecision).toHaveBeenCalledWith(approval, "approve");
  });

  it("counts only contributing context sources and never prices a withheld one", () => {
    const item = (
      ordinal: number,
      sourceKind: string,
      disposition: string,
    ): AgentTurnDetail["context_items"][number] => ({
      ordinal,
      source_kind: sourceKind,
      source_id: `source:${ordinal}`,
      source_revision: "revision:1",
      source_sha256: "a".repeat(64),
      trust_class: "explicit_project_context",
      capacity_source: "conservative",
      original_bytes: 62,
      included_bytes: 62,
      estimated_tokens: 16,
      disposition,
      reason_code: disposition === "unavailable" ? "source_unavailable" : null,
    });
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    roots.push(root);
    act(() => root.render(<AgentActivity events={[]} contextItems={[
      item(1, "current_request", "complete"),
      item(2, "explicit_runtime_output", "unavailable"),
      item(3, "conversation_history", "complete"),
      item(4, "editor_context", "unavailable"),
      item(5, "project_skills", "unavailable"),
      item(6, "workspace_plugin_context", "unavailable"),
    ]} />));

    expect(host.textContent).toContain("Context used · 2 of 6 sources");
    const withheld = [...host.querySelectorAll(".rho-agent-context-withheld")];
    expect(withheld).toHaveLength(4);
    // A source that contributed nothing still names itself and its
    // disposition, and withheld sources keep their original relative order.
    expect(withheld.map((row) => row.textContent)).toEqual([
      "explicit runtime outputunavailable",
      "editor contextunavailable",
      "project skillsunavailable",
      "workspace plugin contextunavailable",
    ]);
    // ...but never carries a byte price, which only the contributing rows have.
    expect(withheld.every((row) => !row.textContent!.includes("bytes"))).toBe(true);
    expect(host.querySelectorAll("li:not(.rho-agent-context-withheld) small")).toHaveLength(2);
  });
});
