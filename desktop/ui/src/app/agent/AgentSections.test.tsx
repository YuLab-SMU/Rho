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
});
