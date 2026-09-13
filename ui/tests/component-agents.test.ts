import { expect, it, vi } from "vitest";
import { ComponentAgents } from "../src/component-agents";
import type { ComponentAgentPorts } from "../src/component-agent-ports";
import type { ComponentAgentConversation } from "../src/generated/ComponentAgentConversation";
import type { ComponentAgentRun } from "../src/generated/ComponentAgentRun";
import type { ComponentAgentStart } from "../src/generated/ComponentAgentStart";
import type { ComponentAgentEventPage } from "../src/generated/ComponentAgentEventPage";
import type { ApplicationWindowRef } from "../src/generated/ApplicationWindowRef";

const clone = <T>(value: T): T => structuredClone(value);
const window: ApplicationWindowRef = { window_id: "one", incarnation: "life-one" };
const conversation = (): ComponentAgentConversation => ({ conversation_id: "c", version: 1, draft_version: 1,
  controller: window, profile: "workspace", draft: "", active_run_id: null, created_at_ms: 1, updated_at_ms: 1 });
const input = { conversation_id: "c", text: "Run once", model_settings_version: 1,
  grant: { mode: "run" as const, session: { workspace_instance_id: "main", session_id: "r-one" }, documents: [], files: [] }, sources: [] };
function run(request: ComponentAgentStart): ComponentAgentRun {
  return { run_id: "run", request: clone(request), profile: "workspace", state: "running",
    model: { protocol: "anthropic", base_url: "https://example.test", model: "fixture", credential: { kind: "environment", name: "MODEL_KEY" } },
    budget: { model_calls: 12, tool_calls: 16, context_bytes: 65536, tool_result_bytes: 262144, output_tokens: 2048, duration_ms: 600000 },
    model_calls: 0, tool_calls: 0, tool_result_bytes: 0, input_tokens: null, output_tokens: null,
    event_cursor: 0, created_at_ms: 1, updated_at_ms: 1, reason: null, context: null, document_versions: null };
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => resolve = r); return { promise, resolve }; }
function fixture() {
  let project = "/one", epoch = 1, connected = true, currentWindow: ApplicationWindowRef | null = window;
  let remote = conversation(), storedRun: ComponentAgentRun | null = null;
  let page: ComponentAgentEventPage = { events: [], cursor: 0, history_gap: false };
  const local = new Map<string, unknown>();
  const ports: ComponentAgentPorts = {
    context: () => ({ project, epoch, connected, session: "r-one", runtimeState: "idle", capabilities: [] }), window: () => currentWindow,
    readLocal: key => clone(local.get(key)), writeLocal: vi.fn((key, value) => local.set(key, clone(value))),
    query: vi.fn(async request => {
      switch (request.query.kind) {
        case "conversation": return { conversation: clone(remote) } as never;
        case "runs": return { runs: [] } as never;
        case "request": return { run: clone(storedRun) } as never;
        case "run": return { run: clone(storedRun) } as never;
        case "events": return { page: clone(page) } as never;
        case "tools": return { tools: [] } as never;
        default: throw new Error("Unexpected query");
      }
    }),
    command: vi.fn(async request => {
      const command = request.command;
      switch (command.kind) {
        case "save_draft":
          if (command.draft.draft_version !== remote.draft_version) throw new Error("Draft conflict");
          remote = { ...remote, draft: command.draft.text, draft_version: remote.draft_version + 1 };
          return { conversation: clone(remote) } as never;
        case "start": storedRun = run(command.request); return { run: clone(storedRun) } as never;
        case "stop": storedRun = { ...storedRun!, state: "stopping", updated_at_ms: 2 }; return { run: clone(storedRun) } as never;
        case "reconcile": return { run: clone(storedRun) } as never;
        case "take_control": remote = { ...remote, controller: request.window, version: remote.version + 1 }; return { conversation: clone(remote) } as never;
        default: throw new Error("Unexpected command");
      }
    }),
  };
  const model = new ComponentAgents(ports);
  return { model, ports, local, remote: (value: ComponentAgentConversation) => remote = value,
    result: (value: ComponentAgentRun | null) => storedRun = value, page: (value: ComponentAgentEventPage) => page = value,
    project: (value: string) => { project = value; epoch++; }, window: (value: ApplicationWindowRef | null) => currentWindow = value,
    online: (value: boolean) => connected = value };
}

it("keeps selected context across reopening while request observation never sends it", async () => {
  const f = fixture(); await f.model.observeConversation("c");
  const composer = { ...input, grant: input.grant, sources: [{ source: "files", label: "notes.R", reference: { path: "notes.R", expected_sha256: "abc" }, inclusion: "text" }] };
  f.model.setComposer("c", composer); f.model.select("c");
  const reopened = new ComponentAgents(f.ports); reopened.reset();
  expect(reopened.getSnapshot().selected).toBe("c");
  expect(reopened.composer("c").sources).toEqual(composer.sources);
  expect(f.ports.command).not.toHaveBeenCalled();
});
it("clears a removed document's authority together with its context", async () => {
  const f = fixture(); await f.model.observeConversation("c");
  const document = { document_id: "doc", document_version: "v1", selection_version: "s1" };
  f.model.includeSource("c", { snapshot: { selection: { source: "editor", label: "analysis.R", reference: { document }, inclusion: "text" }, title: "analysis.R", description: "", text: "1", native_data: { path: "analysis.R" }, truncated: false, observations: [], evidence: [{ kind: "document", document }] }, image_base64: null, image_mime_type: null, observations: [], error: null });
  expect(f.model.composer("c").grant.documents).toEqual([{ document, path: "analysis.R", allow_save: false }]);
  f.model.removeSource("c", 0);
  expect(f.model.composer("c").grant.documents).toEqual([]);
});
it("sends a session credential only through the transient port and persists only its reference", async () => {
  const f = fixture(); await f.model.observeConversation("c");
  f.ports.credential = vi.fn(async () => ({ credential: { kind: "session", key_id: "opaque" } }));
  vi.mocked(f.ports.command).mockImplementationOnce(async request => ({ settings: request.command.kind === "configure" ? request.command.settings : null }) as never);
  await f.model.configure({ version: 0, enabled: true, connection: { protocol: "anthropic", model: "fixture", base_url: "https://example.test", credential: { kind: "session", key_id: "" } } }, "transient-test-secret");
  expect(f.ports.credential).toHaveBeenCalledOnce();
  expect(JSON.stringify(vi.mocked(f.ports.command).mock.calls)).not.toContain("transient-test-secret");
  expect(JSON.stringify(f.model.getSnapshot())).not.toContain("transient-test-secret");
  expect(JSON.stringify(f.model.serialize())).not.toContain("transient-test-secret");
});

it("constructing and restoring only read local state and never submit or test a model", () => {
  const f = fixture(); f.model.reset();
  expect(f.ports.query).not.toHaveBeenCalled(); expect(f.ports.command).not.toHaveBeenCalled();
});
it("a delayed draft acknowledgement preserves later typing and advances its CAS base", async () => {
  const f = fixture(); await f.model.observeConversation("c"); f.model.editDraft("c", "first");
  const ack = deferred<never>(); vi.mocked(f.ports.command).mockReturnValueOnce(ack.promise);
  const saving = f.model.flushDraft("c"); f.model.editDraft("c", "second");
  ack.resolve({ conversation: { ...conversation(), draft: "first", draft_version: 2 } } as never); await saving;
  expect(f.model.getSnapshot().drafts.get("c")).toMatchObject({ text: "second", baseVersion: 2, dirty: true });
});
it("another controller's draft is a conflict copy until explicit resolution", async () => {
  const f = fixture(); await f.model.observeConversation("c"); f.model.editDraft("c", "local");
  f.remote({ ...conversation(), version: 2, draft_version: 2, draft: "other", controller: { window_id: "two", incarnation: "two" } });
  await f.model.observeConversation("c"); expect(f.model.canControl("c")).toBe(false);
  await expect(f.model.flushDraft("c")).rejects.toThrow(/conflict/);
  await f.model.takeControl("c");
  expect(f.model.getSnapshot().drafts.get("c")).toMatchObject({ text: "local", conflict: "other" });
  f.model.resolveDraft("c", true); await f.model.flushDraft("c");
  expect(f.model.getSnapshot().drafts.get("c")?.dirty).toBe(false);
});
it("lost Start acknowledgement persists its immutable identity and observes without replay", async () => {
  const f = fixture(); await f.model.observeConversation("c");
  vi.mocked(f.ports.command).mockRejectedValueOnce(new Error("ACK lost"));
  await expect(f.model.start(input)).rejects.toThrow("ACK lost");
  const pending = f.model.getSnapshot().pending[0];
  expect(pending.state).toBe("uncertain");
  await f.model.observeSubmission(pending.request.request_id);
  expect(f.model.getSnapshot().pending).toHaveLength(1);
  await expect(f.model.start(input)).rejects.toThrow("previous submission");
  const restored = new ComponentAgents(f.ports); restored.reset();
  expect(restored.getSnapshot().pending[0].request).toEqual(pending.request);
  f.result(run(pending.request)); await restored.observeSubmission(pending.request.request_id);
  expect(restored.getSnapshot().pending).toHaveLength(0);
  expect(restored.getSnapshot().runs.get("run")?.request.request_id).toBe(pending.request.request_id);
  expect(f.ports.command).toHaveBeenCalledTimes(1);
});

it("a completed initial rejection with an absent authoritative request releases the retained draft", async () => {
  const f = fixture(); await f.model.observeConversation("c"); f.model.editDraft("c", "keep me");
  vi.mocked(f.ports.command).mockRejectedValueOnce(Object.assign(new Error("Invalid scope"), { status: 409 }));
  await expect(f.model.start(input)).rejects.toThrow("Invalid scope");
  expect(f.model.getSnapshot().pending).toHaveLength(0);
  expect(f.model.getSnapshot().drafts.get("c")?.text).toBe("keep me");
  expect(f.ports.command).toHaveBeenCalledOnce();
});
it("does not submit when the recovery identity cannot be persisted", async () => {
  const f = fixture(); await f.model.observeConversation("c");
  vi.mocked(f.ports.writeLocal).mockImplementation(() => { throw new Error("quota"); });
  await expect(f.model.start(input)).rejects.toThrow("not submitted");
  expect(f.ports.command).not.toHaveBeenCalled();
});
it("late observations and acknowledgements do not overwrite another project", async () => {
  const f = fixture(); await f.model.observeConversation("c");
  const ack = deferred<never>(); vi.mocked(f.ports.command).mockReturnValueOnce(ack.promise);
  const starting = f.model.start(input);
  await vi.waitFor(() => expect(f.model.getSnapshot().pending).toHaveLength(1));
  const request = f.model.getSnapshot().pending[0].request;
  f.project("/two"); f.model.reset(); ack.resolve({ run: run(request) } as never); await starting;
  expect(f.model.getSnapshot().runs.size).toBe(0);
  expect(f.model.getSnapshot().pending).toHaveLength(0);
  expect(f.local.get("/one")).toMatchObject({ pending: [{ request }] });
});
it("freezes a submission's targets even if the caller changes its input during delivery", async () => {
  const f = fixture(); await f.model.observeConversation("c"); const value = clone(input);
  const ack = deferred<never>(); vi.mocked(f.ports.command).mockReturnValueOnce(ack.promise);
  const starting = f.model.start(value); value.grant.session.session_id = "different";
  await vi.waitFor(() => expect(f.model.getSnapshot().pending).toHaveLength(1));
  const pending = f.model.getSnapshot().pending[0]; expect(pending.request.grant.session?.session_id).toBe("r-one");
  ack.resolve({ run: run(pending.request) } as never); await starting;
});
it("rejects a mismatched event page without advancing its cursor", async () => {
  const f = fixture(); f.page({ events: [{ run_id: "other", sequence: 3, created_at_ms: 1, content: { kind: "text", text: "wrong" } }], cursor: 3, history_gap: false });
  await expect(f.model.observeEvents("run")).rejects.toThrow("identity");
  f.page({ events: [{ run_id: "run", sequence: 3, created_at_ms: 1, content: { kind: "text", text: "right" } }], cursor: 3, history_gap: true });
  await f.model.observeEvents("run"); expect(f.model.getSnapshot().historyGap.get("run")).toBe(true);
  expect(f.model.getSnapshot().events.get("run")?.length).toBe(1);
  expect(vi.mocked(f.ports.query).mock.calls[1][0].query).toMatchObject({ after: 0 });
});
it("Stop keeps the returned stopping state and never invents scientific cancellation", async () => {
  const f = fixture(); await f.model.observeConversation("c"); await f.model.start(input);
  await f.model.controlRun("run", "stop"); expect(f.model.getSnapshot().runs.get("run")?.state).toBe("stopping");
});
it("snapshots cannot mutate owned drafts or run inputs", async () => {
  const f = fixture(); await f.model.observeConversation("c"); await f.model.start(input);
  expect(() => { f.model.getSnapshot().drafts.get("c")!.text = "changed"; }).toThrow();
  expect(() => { f.model.getSnapshot().runs.get("run")!.request.text = "changed"; }).toThrow();
});
it("offline draft copies survive reopening without starting a model", async () => {
  const f = fixture(); await f.model.observeConversation("c"); f.online(false);
  f.model.editDraft("c", "离线草稿 🧬"); const restored = new ComponentAgents(f.ports); restored.reset();
  expect(restored.getSnapshot().drafts.get("c")?.text).toBe("离线草稿 🧬");
  expect(f.ports.command).not.toHaveBeenCalled();
});
it("reopening history only queries the authoritative run index", async () => {
  const f = fixture(); await f.model.observeConversation("c"); await f.model.observeHistory("c");
  expect(f.model.getSnapshot().history.get("c")).toEqual({ runs: [], before: null, next: null });
  expect(f.ports.command).not.toHaveBeenCalled();
});
it("late event pages from an old window incarnation are ignored", async () => {
  const f = fixture(); const page = deferred<never>(); vi.mocked(f.ports.query).mockReturnValueOnce(page.promise);
  const reading = f.model.observeEvents("run"); f.window({ window_id: "one", incarnation: "new-life" });
  page.resolve({ page: { events: [{ run_id: "run", sequence: 1, created_at_ms: 1, content: { kind: "text", text: "old" } }], cursor: 1, history_gap: false } } as never);
  await reading; expect(f.model.getSnapshot().events.size).toBe(0);
});
it("bounds retained event bytes while marking the omitted history", async () => {
  const f = fixture(); f.page({ events: Array.from({ length: 100 }, (_, index) => ({ run_id: "run", sequence: index + 1,
    created_at_ms: 1, content: { kind: "text" as const, text: "界".repeat(1500) } })), cursor: 100, history_gap: false });
  await f.model.observeEvents("run");
  expect(f.model.getSnapshot().historyGap.get("run")).toBe(true);
  expect(new TextEncoder().encode(JSON.stringify(f.model.getSnapshot().events.get("run"))).length).toBeLessThanOrEqual(256 * 1024);
  expect(f.model.getSnapshot().events.get("run")?.at(-1)?.sequence).toBe(100);
});
it("an older history response cannot replace the user's newer page selection", async () => {
  const f = fixture(); await f.model.observeConversation("c");
  const old = deferred<never>(); vi.mocked(f.ports.query).mockReturnValueOnce(old.promise);
  const reading = f.model.observeHistory("c", "older-page");
  await f.model.observeHistory("c"); old.resolve({ runs: [] } as never); await reading;
  expect(f.model.getSnapshot().history.get("c")?.before).toBeNull();
});
it("a newer authoritative conversation version is used for an explicit Start", async () => {
  const f = fixture(); await f.model.observeConversation("c");
  f.remote({ ...conversation(), version: 4 });
  const result = await f.model.start(input);
  expect(result?.request.conversation_version).toBe(4);
});
it("serializes submission preflight so a second click cannot mint another request", async () => {
  const f = fixture(); await f.model.observeConversation("c");
  const preflight = deferred<never>(); vi.mocked(f.ports.query).mockReturnValueOnce(preflight.promise);
  const first = f.model.start(input);
  expect(f.model.getSnapshot().submitting.has("c")).toBe(true);
  await expect(f.model.start(input)).rejects.toThrow("already in progress");
  preflight.resolve({ conversation: conversation() } as never); await first;
  expect(f.ports.command).toHaveBeenCalledTimes(1);
  expect(f.model.getSnapshot().submitting.size).toBe(0);
});
it("an obsolete preflight cannot clear a newer project submission", async () => {
  const f = fixture(); await f.model.observeConversation("c");
  const old = deferred<never>(); vi.mocked(f.ports.query).mockReturnValueOnce(old.promise);
  const first = f.model.start(input);
  f.project("/two"); f.model.reset();
  const current = deferred<never>(); vi.mocked(f.ports.query).mockReturnValueOnce(current.promise);
  const second = f.model.start(input);
  old.resolve({ conversation: conversation() } as never); await first;
  expect(f.model.getSnapshot().submitting.has("c")).toBe(true);
  current.resolve({ conversation: conversation() } as never); await second;
  expect(f.ports.command).toHaveBeenCalledTimes(1);
  expect(vi.mocked(f.ports.command).mock.calls[0][0].project_root).toBe("/two");
});
it("an evicted event request cannot overwrite the same run after it is reopened", async () => {
  const f = fixture(); await f.model.observeEvents("run");
  const old = deferred<never>(); vi.mocked(f.ports.query).mockReturnValueOnce(old.promise);
  const first = f.model.observeEvents("run");
  for (let index = 0; index < 32; index++) await f.model.observeEvents(`other-${index}`);
  const current = deferred<never>(); vi.mocked(f.ports.query).mockReturnValueOnce(current.promise);
  const second = f.model.observeEvents("run");
  const page = (text: string) => ({ page: { events: [{ run_id: "run", sequence: 1, created_at_ms: 1,
    content: { kind: "text", text } }], cursor: 1, history_gap: false } });
  old.resolve(page("old") as never); await first;
  expect(f.model.getSnapshot().events.has("run")).toBe(false);
  current.resolve(page("current") as never); await second;
  expect(f.model.getSnapshot().events.get("run")?.[0].content).toEqual({ kind: "text", text: "current" });
});
it("an explicit retry reuses the frozen request rather than later drafts or settings", async () => {
  const f = fixture(); await f.model.observeConversation("c");
  vi.mocked(f.ports.command).mockRejectedValueOnce(new Error("ACK lost"));
  await expect(f.model.start(input)).rejects.toThrow("ACK lost");
  const original = clone(vi.mocked(f.ports.command).mock.calls[0][0]);
  const pending = f.model.getSnapshot().pending[0];
  f.model.editDraft("c", "later question"); f.remote({ ...conversation(), version: 9 });
  await f.model.retrySubmission(pending.request.request_id);
  expect(vi.mocked(f.ports.command).mock.calls[1][0]).toEqual(original);
  expect(f.model.getSnapshot().drafts.get("c")?.text).toBe("later question");
});
it("cannot retry an old request through a new window incarnation", async () => {
  const f = fixture(); await f.model.observeConversation("c");
  vi.mocked(f.ports.command).mockRejectedValueOnce(new Error("ACK lost"));
  await expect(f.model.start(input)).rejects.toThrow("ACK lost");
  const id = f.model.getSnapshot().pending[0].request.request_id;
  f.window({ window_id: "one", incarnation: "new" });
  await expect(f.model.retrySubmission(id)).rejects.toThrow("another window incarnation");
  expect(f.ports.command).toHaveBeenCalledTimes(1);
});
