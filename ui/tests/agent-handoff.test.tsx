import { useSyncExternalStore } from "react";
import { expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AgentHandoffs } from "../src/agent-handoffs";
import type { AgentHandoffPorts } from "../src/agent-handoff-ports";
import type { ProjectAgentTaskSummary } from "../src/generated/ProjectAgentTaskSummary";
import type { AgentTasks } from "../src/agent-tasks";

const fixtures = vi.hoisted(() => ({ owner: null as AgentHandoffs | null, tasks: [] as ProjectAgentTaskSummary[], tasksOwner: null as unknown as AgentTasks, select: vi.fn(), report: vi.fn(), open: vi.fn() }));
vi.mock("../src/context", () => ({
  useAgentHandoffs: () => { useSyncExternalStore(fixtures.owner!.subscribe, fixtures.owner!.getSnapshot); return fixtures.owner!; },
  useAgentTasks: () => fixtures.tasksOwner,
  useNavigation: () => ({ openOperation: fixtures.open }),
}));
import { AgentHandoffPreview } from "../src/panels/agent-handoff";

const source = { kind: "rho" as const, conversation_id: "source" }, target = { kind: "native" as const, task_id: "target" }, window = { window_id: "one", incarnation: "current" };
async function setup() {
  const selection = { source: "operations", label: "Original run", reference: { operation_id: "original-op" }, inclusion: "summary" };
  const ports: AgentHandoffPorts = {
    context: () => ({ project: "/study", epoch: 1, connected: true, session: "r", runtimeState: "idle", capabilities: [] }), window: () => window,
    query: vi.fn(async request => request.query.kind === "source" ? { kind: "source", source: { source, title: "Review labels", revision: "v1", body: "Goal: Compare\n\nConfirmed:\n\nNext: Review", context: [selection], truncated: false, notices: ["Source task attachments are not copied."] } } : { kind: "target", target: { target, title: "Compare results", draft: { text: "Existing draft stays first", assets: ["owned-asset"], context: [] }, draft_version: 2, controller: window, control_generation: 1, writable: true, reason: null } }),
    command: vi.fn(async request => ({ request_id: request.request_id, source, target, target_draft_version: 3, created_at_ms: 1 })),
    preview: vi.fn(async () => ({ selection, title: "Original run", description: "Original operation", text: "Succeeded", native_data: {}, columns: [], rows: [], image_base64: null, image_mime_type: null, inclusions: ["summary"], truncated: false })),
    synchronizeDraft: vi.fn(async () => {}), refreshTarget: vi.fn(async () => {}), changed: vi.fn(),
  };
  fixtures.owner = new AgentHandoffs(ports);
  const summary = { created_at_ms: 1, updated_at_ms: 1, archived: false, state: "draft", has_draft: true, permissions: 0, attention_reason: null, history_gap: false };
  fixtures.tasks = [{ ...summary, reference: source, provider: null, title: "Review labels" }, { ...summary, reference: target, provider: "kimi", title: "Compare results" }];
  fixtures.tasksOwner = { getSnapshot: () => ({ projectTasks: fixtures.tasks, next: null }), connected: true, reportError: fixtures.report, chooseTask: fixtures.select,
    readHandoffTargets: vi.fn(async () => ({ tasks: fixtures.tasks, next: null })) } as unknown as AgentTasks;
  await fixtures.owner.prepare(source); return { ports, owner: fixtures.owner };
}
it("the in-panel preview keeps references optional and Enter never adds or sends the handoff", async () => {
  const f = await setup(), view = render(<AgentHandoffPreview source={source} />);
  await screen.findByRole("option", { name: "Compare results · Kimi Code" });
  fireEvent.change(screen.getByRole("combobox", { name: "Send context to" }), { target: { value: "native:target" } });
  await screen.findByText("Existing draft stays first"); expect(screen.getByText("1 existing attachment will be kept.")).toBeTruthy();
  expect(screen.getByText("Source task attachments are not copied.")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Original run", exact: true })); await screen.findByText("Succeeded");
  fireEvent.click(screen.getByRole("button", { name: "Open original operation ↗" })); expect(fixtures.open).toHaveBeenCalledWith("original-op");
  fireEvent.click(screen.getByRole("button", { name: "Remove Original run from handoff" }));
  const input = screen.getByRole("textbox", { name: "Handoff draft" }); fireEvent.change(input, { target: { value: "Goal: 用户编辑\n\nConfirmed:\n\nNext:" } });
  fireEvent.keyDown(input, { key: "Enter", code: "Enter" }); expect(f.ports.command).not.toHaveBeenCalled();
  fireEvent.compositionStart(input); await waitFor(() => expect((screen.getByRole("button", { name: "Add to draft" }) as HTMLButtonElement).disabled).toBe(true));
  fireEvent.compositionEnd(input, { data: "完成" });
  await waitFor(() => expect((screen.getByRole("button", { name: "Add to draft" }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole("button", { name: "Add to draft" })); await screen.findByText("Added to the target draft");
  expect(screen.queryByRole("region", { name: "Existing target draft" })).toBeNull();
  expect(f.ports.command).toHaveBeenCalledOnce(); expect(vi.mocked(f.ports.command).mock.calls[0][0].context).toEqual([]);
  view.unmount(); f.owner.dispose();
});
it("an unknown receipt locks the original form and exposes only explicit reconciliation actions", async () => {
  const f = await setup(); await f.owner.selectTarget(source, target);
  vi.mocked(f.ports.command).mockRejectedValueOnce(new Error("Response unavailable")); await f.owner.appendToDraft(source);
  const view = render(<AgentHandoffPreview source={source} />);
  expect((screen.getByRole("textbox", { name: "Handoff draft" }) as HTMLTextAreaElement).readOnly).toBe(true);
  expect(screen.getByRole("button", { name: "Check receipt" })).toBeTruthy(); expect(screen.getByRole("button", { name: "Retry original request" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Add to draft" })).toBeNull(); expect(f.ports.command).toHaveBeenCalledOnce();
  expect(screen.queryByRole("region", { name: "Existing target draft" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" })); expect(f.owner.editor(source)?.pending).not.toBeNull();
  view.unmount(); f.owner.dispose();
});
