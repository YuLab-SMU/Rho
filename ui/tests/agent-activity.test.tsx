import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { AgentActivity, agentActivity } from "../src/panels/agent-activity";
import type { AgentTaskSummary } from "../src/generated/AgentTaskSummary";
import type { AgentTaskEvent } from "../src/generated/AgentTaskEvent";
afterEach(cleanup);
const task = (state: string) => ({ attachment: { state, generation: 2 } }) as AgentTaskSummary;
const event = (kind: string, status: string | null, overrides = {}) => ({ kind, status, generation: 2, source: "observation", request_id: "current", role: kind === "message" ? "user" : null, observed_at_ms: Date.now(), ...overrides }) as AgentTaskEvent;
it("shows immediate sending, real native phases and permission waits without claiming thought text", () => {
  expect(agentActivity(task("draft"), [], true)?.label).toBe("Sending message");
  expect(agentActivity(task("connecting"), [], true)?.label).toBe("Connecting to Agent");
  const events = [event("message", null), event("activity", "thinking")];
  expect(agentActivity(task("running"), events, false)?.label).toBe("Thinking");
  expect(agentActivity(task("waiting_for_permission"), events, false)?.label).toBe("Waiting for your permission");
  expect(agentActivity(task("ready"), events, false)).toBeNull();
});
it("ignores another generation, earlier turn and replay when describing live activity", () => {
  const events = [event("activity", "thinking", { request_id: "old" }), event("message", null), event("activity", "thinking", { generation: 1 }), event("activity", "thinking", { source: "native_history" })];
  expect(agentActivity(task("running"), events, false)?.label).toBe("Waiting for Agent");
});
it("reports a quiet interval without pretending the run stopped and removes activity at completion", () => {
  const events = [event("message", null), event("activity", "working", { observed_at_ms: Date.now() - 42000 })];
  const view = render(<AgentActivity task={task("running")} events={events} pending={false} now={Date.now()} />);
  expect(view.getByRole("status").textContent).toContain("No new activity for 42s");
  view.rerender(<AgentActivity task={task("ready")} events={events} pending={false} now={Date.now()} />);
  expect(view.queryByRole("status")).toBeNull();
});
