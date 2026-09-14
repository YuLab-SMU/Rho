import { expect, it, vi } from "vitest";
import { AgentHandoffs } from "../src/agent-handoffs";
import type { AgentHandoffPorts } from "../src/agent-handoff-ports";
import type { AgentHandoffTargetSnapshot } from "../src/generated/AgentHandoffTargetSnapshot";
import type { AgentHandoffSourceSnapshot } from "../src/generated/AgentHandoffSourceSnapshot";
import type { AgentHandoffReceipt } from "../src/generated/AgentHandoffReceipt";
import type { AgentHandoffCommand } from "../src/generated/AgentHandoffCommand";

const clone = <T>(value: T): T => structuredClone(value);
const source = { kind: "rho" as const, conversation_id: "source" }, target = { kind: "native" as const, task_id: "target" };
const windowRef = { window_id: "one", incarnation: "current" };
const context = [{ source: "files", label: "notes.R", reference: { path: "notes.R", expected_sha256: `sha256:${"a".repeat(64)}` }, inclusion: "text" }, { source: "operations", label: "Original run", reference: { operation_id: "original-operation" }, inclusion: "summary" }];
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => resolve = done); return { promise, resolve }; }
function fixture() {
  let project = "/study", window = clone(windowRef), receipt: AgentHandoffReceipt | null = null;
  let original: AgentHandoffSourceSnapshot = { source, title: "Review plot labels", body: "Goal: Review labels\n\nConfirmed:\n\nNext:", context: clone(context), revision: "source-v1", truncated: false, notices: [] };
  let current: AgentHandoffTargetSnapshot = { target, title: "Compare results", draft: { text: "Existing target draft", assets: ["target-asset"], context: [] }, draft_version: 2, controller: windowRef, control_generation: 3, writable: true, reason: null };
  const ports: AgentHandoffPorts = {
    context: () => ({ epoch: 1, project, connected: true, session: "r", runtimeState: "idle", capabilities: [] }), window: () => window,
    query: vi.fn(async request => request.query.kind === "source" ? { kind: "source", source: clone(original) } : request.query.kind === "target" ? { kind: "target", target: clone(current) } : { kind: "receipt", receipt: clone(receipt) }),
    command: vi.fn(async request => { receipt = { request_id: request.request_id, source: request.source, target: request.target, target_draft_version: current.draft_version + 1, created_at_ms: 10 }; return clone(receipt); }),
    synchronizeDraft: vi.fn(async () => {}), refreshTarget: vi.fn(async () => {}), preview: vi.fn(async () => null), changed: vi.fn(),
  };
  const model = new AgentHandoffs(ports);
  return { model, ports, target: (update: Partial<AgentHandoffTargetSnapshot>) => current = { ...current, ...update }, source: (update: Partial<AgentHandoffSourceSnapshot>) => original = { ...original, ...update }, receipt: (value: AgentHandoffReceipt | null) => receipt = value, window: (value: typeof windowRef) => window = value, project: (value: string) => project = value };
}
it("prepares a reviewed body and original references, then only appends to the target draft", async () => {
  const f = fixture(); await f.model.prepare(source); f.model.edit(source, "Goal: Compare\nConfirmed: User-reviewed fact\nNext: Label");
  f.model.removeContext(source, 0); await f.model.preview(source, context[1]);
  expect(f.ports.preview).toHaveBeenCalledWith(context[1]); expect(f.ports.command).not.toHaveBeenCalled();
  await f.model.selectTarget(source, target); expect(f.model.editor(source)?.target?.draft.text).toBe("Existing target draft");
  await f.model.appendToDraft(source);
  const request = vi.mocked(f.ports.command).mock.calls[0][0];
  expect(Object.keys(request).sort()).toEqual(["body", "context", "project_root", "request_id", "source", "source_revision", "target", "target_control_generation", "target_draft_version", "window"]);
  expect(request).toMatchObject({ source, target, source_revision: "source-v1", target_draft_version: 2, target_control_generation: 3, context: [context[1]], body: "Goal: Compare\nConfirmed: User-reviewed fact\nNext: Label" });
  expect(f.ports.command).toHaveBeenCalledOnce(); expect(f.ports.refreshTarget).toHaveBeenCalledWith(target);
  expect(f.model.editor(source)?.pending).toBeNull(); expect(f.model.editor(source)?.receipt?.request_id).toBe(request.request_id);
});
it("a changed target is shown for review without losing handoff edits or issuing a command", async () => {
  const f = fixture(); await f.model.prepare(source); await f.model.selectTarget(source, target); f.model.edit(source, "Keep this handoff");
  f.target({ draft_version: 3, draft: { text: "Changed target draft", assets: ["target-asset"], context: [] } }); await f.model.appendToDraft(source);
  expect(f.ports.command).not.toHaveBeenCalled(); expect(f.model.editor(source)?.body).toBe("Keep this handoff");
  expect(f.model.editor(source)?.target?.draft.text).toBe("Changed target draft"); expect(f.model.editor(source)?.error).toContain("Review");
  await f.model.appendToDraft(source); expect(vi.mocked(f.ports.command).mock.calls[0][0].target_draft_version).toBe(3);
});
it("a rejected CAS keeps manual edits and source removals while refreshing both observations", async () => {
  const f = fixture(); await f.model.prepare(source); await f.model.selectTarget(source, target); f.model.edit(source, "Reviewed handoff"); f.model.removeContext(source, 0);
  vi.mocked(f.ports.command).mockRejectedValueOnce(Object.assign(new Error("The source observation expired."), { submission: "rejected", diagnostic: { code: "observation_expired" } }));
  await f.model.appendToDraft(source); expect(f.model.editor(source)?.pending).toBeNull(); expect(f.model.editor(source)?.target).toBeNull();
  f.source({ revision: "source-v2", body: "Updated default body" }); f.target({ draft_version: 4 });
  await f.model.reloadSource(source); await f.model.selectTarget(source, target); await f.model.appendToDraft(source);
  const calls = vi.mocked(f.ports.command).mock.calls.map(([request]) => request);
  expect(calls[1]).toMatchObject({ body: "Reviewed handoff", context: [context[1]], source_revision: "source-v2", target_draft_version: 4 });
  expect(calls[1].request_id).not.toBe(calls[0].request_id);
});
it("unknown acknowledgements restore the immutable request and retry it only on explicit action", async () => {
  const f = fixture(); await f.model.prepare(source); await f.model.selectTarget(source, target);
  vi.mocked(f.ports.command).mockRejectedValueOnce(new Error("Acknowledgement unavailable")); await f.model.appendToDraft(source);
  const original = clone(vi.mocked(f.ports.command).mock.calls[0][0]);
  const restored = new AgentHandoffs(f.ports); restored.restore(f.model.serialize());
  restored.edit(source, "Must not replace the pending body"); await restored.selectTarget(source, { kind: "rho", conversation_id: "another" });
  expect(restored.editor(source)?.pending).toEqual(original); expect(f.ports.command).toHaveBeenCalledOnce();
  await restored.check(source); expect(f.ports.command).toHaveBeenCalledOnce(); expect(restored.editor(source)?.pending).toEqual(original);
  await restored.retry(source); expect(vi.mocked(f.ports.command).mock.calls[1][0]).toEqual(original); expect(restored.editor(source)?.receipt?.request_id).toBe(original.request_id);
});
it("a receipt can confirm a lost acknowledgement after window replacement without retrying its write", async () => {
  const f = fixture(); await f.model.prepare(source); await f.model.selectTarget(source, target);
  let sent!: AgentHandoffCommand; vi.mocked(f.ports.command).mockImplementationOnce(async request => { sent = clone(request); throw new Error("ACK lost"); }); await f.model.appendToDraft(source);
  f.window({ ...windowRef, incarnation: "replacement" });
  await expect(f.model.retry(source)).rejects.toThrow("another window incarnation");
  f.receipt({ request_id: sent.request_id, source, target, target_draft_version: 3, created_at_ms: 10 }); await f.model.check(source);
  expect(f.ports.command).toHaveBeenCalledOnce(); expect(f.model.editor(source)?.pending).toBeNull(); expect(f.model.editor(source)?.receipt?.request_id).toBe(sent.request_id);
});
it("a rejected retry cannot discard an original handoff whose acknowledgement is unknown", async () => {
  const f = fixture(); await f.model.prepare(source); await f.model.selectTarget(source, target);
  vi.mocked(f.ports.command).mockRejectedValueOnce(new Error("ACK lost")); await f.model.appendToDraft(source);
  const original = clone(vi.mocked(f.ports.command).mock.calls[0][0]);
  vi.mocked(f.ports.command).mockRejectedValueOnce(Object.assign(new Error("Retry rejected"), { submission: "rejected" })); await f.model.retry(source);
  expect(vi.mocked(f.ports.command).mock.calls[1][0]).toEqual(original); expect(f.model.editor(source)?.pending).toEqual(original);
  await f.model.check(source); expect(f.model.editor(source)?.pending).toEqual(original); expect(f.ports.command).toHaveBeenCalledTimes(2);
  await f.model.retry(source); expect(vi.mocked(f.ports.command).mock.calls[2][0]).toEqual(original);
  expect(f.model.editor(source)?.receipt?.request_id).toBe(original.request_id); expect(f.model.editor(source)?.pending).toBeNull();
});
it("local backup failure prevents submission and retains the handoff text", async () => {
  const f = fixture(); await f.model.prepare(source); await f.model.selectTarget(source, target); f.model.edit(source, "Keep locally");
  vi.mocked(f.ports.changed).mockImplementation(required => { if (required) throw new Error("Storage full"); }); await f.model.appendToDraft(source);
  expect(f.ports.command).not.toHaveBeenCalled(); expect(f.model.editor(source)?.pending).toBeNull(); expect(f.model.editor(source)?.body).toBe("Keep locally");
});
it("unresolved local target edits prevent reading and overwriting the saved draft", async () => {
  const f = fixture(); await f.model.prepare(source); f.model.edit(source, "Keep handoff edits");
  vi.mocked(f.ports.synchronizeDraft).mockRejectedValueOnce(new Error("Resolve the existing draft conflict.")); await f.model.selectTarget(source, target);
  expect(vi.mocked(f.ports.query).mock.calls.filter(([request]) => request.query.kind === "target")).toEqual([]);
  expect(f.model.editor(source)?.target).toBeNull(); expect(f.model.editor(source)?.body).toBe("Keep handoff edits"); expect(f.ports.command).not.toHaveBeenCalled();
});
it("late observations from a previous project cannot repopulate the handoff form", async () => {
  const f = fixture(), read = deferred<Awaited<ReturnType<AgentHandoffPorts["query"]>>>();
  vi.mocked(f.ports.query).mockReturnValueOnce(read.promise); const opening = f.model.prepare(source); await Promise.resolve();
  f.model.reset(); f.project("/other"); read.resolve({ kind: "source", source: { source, title: "Old", body: "Old project", context: [], revision: "old", truncated: false, notices: [] } }); await opening;
  expect(f.model.editor(source)).toBeUndefined(); expect(f.ports.command).not.toHaveBeenCalled();
});
