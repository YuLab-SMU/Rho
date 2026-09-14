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
const conversation = (): ComponentAgentConversation => ({ conversation_id: "c", title: "New task", archived: false, draft_content: {text:"",assets:[],context:[]}, version: 1, draft_version: 1,
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
  let assets: import("../src/generated/AgentAsset").AgentAsset[] = [];
  let page: ComponentAgentEventPage = { events: [], cursor: 0, history_gap: false };
  const local = new Map<string, unknown>();
  const ports: ComponentAgentPorts = {
    context: () => ({ project, epoch, connected, session: "r-one", runtimeState: "idle", capabilities: [] }), window: () => currentWindow,
    readLocal: key => clone(local.get(key)), writeLocal: vi.fn((key, value) => local.set(key, clone(value))),
    query: vi.fn(async request => {
      switch (request.query.kind) {
        case "assets": return {assets:clone(assets)} as never;
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
        case "archive": remote={...remote,archived:command.archived,version:remote.version+1}; return {conversation:clone(remote)} as never;
        case "rename": remote={...remote,title:command.title,version:remote.version+1}; return {conversation:clone(remote)} as never;
        case "add_asset": { const asset={asset_id:command.asset_id,name:command.name,mime_type:command.mime_type,bytes:3,sha256:"sha256:fixture"}; assets.push(asset); return {asset:clone(asset)} as never; }
        case "save_draft":
          if (command.draft.draft_version !== remote.draft_version) throw new Error("Draft conflict");
          remote = { ...remote, draft: command.draft.text, draft_content: command.draft.content ?? {text:command.draft.text,assets:[],context:[]}, draft_grant:command.draft.grant, draft_version: remote.draft_version + 1 };
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
    assets: (value: import("../src/generated/AgentAsset").AgentAsset[]) => assets=value, result: (value: ComponentAgentRun | null) => storedRun = value, page: (value: ComponentAgentEventPage) => page = value,
    project: (value: string) => { project = value; epoch++; }, window: (value: ApplicationWindowRef | null) => currentWindow = value,
    online: (value: boolean) => connected = value };
}

it("keeps selected context across reopening while request observation never sends it", async () => {
  const f = fixture(); await f.model.observeConversation("c");
  const composer = { ...input, grant: input.grant, sources: [{ source: "files", label: "notes.R", reference: { path: "notes.R", expected_sha256: "abc" }, inclusion: "text" }] };
  f.model.setComposer("c", composer);
  const reopened = new ComponentAgents(f.ports); reopened.reset();
  expect(f.model.serialize()).not.toHaveProperty("selected");
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
it("saves a local credential through its separate port and persists only its immutable reference", async () => {
  const f = fixture(); await f.model.observeConversation("c");
  f.ports.credential = vi.fn(async () => ({ credential: { kind: "local_file", key_id: "opaque" } }));
  vi.mocked(f.ports.command).mockImplementationOnce(async request => ({ settings: request.command.kind === "configure" ? request.command.settings : null }) as never);
  await f.model.configure({ version: 0, enabled: true, connection: { protocol: "anthropic", model: "fixture", base_url: "https://example.test", credential: { kind: "local_file", key_id: "" } } }, "transient-test-secret");
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
  vi.mocked(f.ports.command).mockRejectedValueOnce(Object.assign(new Error("Invalid scope"), { status: 409, submission: "rejected" }));
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

it("retains an unknown request even when the HTTP status looks like a rejection", async () => {
  const f = fixture(); await f.model.observeConversation("c");
  const diagnostic = { code: "outcome_uncertain", message: "Original commit needs inspection", continuation: "inspect_original", next_reads: [] };
  vi.mocked(f.ports.command).mockRejectedValueOnce(Object.assign(new Error(diagnostic.message), { status: 409, submission: "unknown", diagnostic }));
  await expect(f.model.start(input)).rejects.toThrow(diagnostic.message);
  expect(f.model.getSnapshot().pending).toHaveLength(1);
  expect(f.model.getSnapshot().errorDiagnostic).toEqual(diagnostic);
  expect(vi.mocked(f.ports.query).mock.calls.some(([request]) => request.query.kind === "request")).toBe(false);
});

it("keeps the previous settings when a newly persisted credential loses the settings CAS", async () => {
  const f = fixture(); await f.model.observeConversation("c");
  f.ports.credential = vi.fn(async () => ({ credential: { kind: "local_file", key_id: "new-immutable-key" } }));
  vi.mocked(f.ports.command).mockRejectedValueOnce(new Error("Settings changed"));
  await expect(f.model.configure({ version: 0, enabled: true, connection: { protocol: "anthropic", model: "fixture", base_url: "https://example.test", credential: { kind: "local_file", key_id: "previous" } } }, "private-key-value")).rejects.toThrow("Settings changed");
  expect(f.ports.credential).toHaveBeenCalledOnce();
  expect(f.model.getSnapshot().settings).toBeNull();
  expect(JSON.stringify(vi.mocked(f.ports.command).mock.calls)).not.toContain("private-key-value");
  expect(JSON.stringify(f.model.serialize())).not.toContain("private-key-value");
});

it("a context-only draft remains dirty until its full content and permission target CAS is acknowledged", async () => {
  const f=fixture(); await f.model.observeConversation("c");
  const source={source:"workspace",label:"Main",reference:{workspace_instance_id:"main",expected_session:"r-one"},inclusion:"summary"};
  f.model.setComposer("c",{sources:[source],grant:{...input.grant,mode:"explain",permission_policy:"auto_approval"}});
  await f.model.observeConversation("c"); expect(f.model.getSnapshot().drafts.get("c")?.dirty).toBe(true);
  await f.model.flushDraft("c"); expect(f.model.getSnapshot().drafts.get("c")?.dirty).toBe(false);
  const update=vi.mocked(f.ports.command).mock.calls[0][0].command;
  expect(update).toMatchObject({kind:"save_draft",draft:{content:{text:"",assets:[],context:[source]},grant:{permission_policy:"auto_approval",session:input.grant.session}}});
  const reopened=new ComponentAgents(f.ports); await reopened.observeConversation("c");
  expect(reopened.composer("c")).toEqual(f.model.composer("c"));
});
it("Rho keeps a committed IME candidate locally if ownership changes during composition", async () => {
  const f=fixture(); await f.model.observeConversation("c");
  f.remote({...conversation(),controller:{window_id:"other",incarnation:"other"},draft:"Other draft",draft_version:2});
  await f.model.observeConversation("c"); f.model.commitComposition("c","检查这个数据");
  expect(f.model.getSnapshot().drafts.get("c")).toMatchObject({text:"检查这个数据",conflict:"Other draft",dirty:true});
  expect(f.ports.command).not.toHaveBeenCalled();
});

it("uses the typed busy reference to show the already running diagnostic without starting another test", async () => {
  const f = fixture(); await f.model.observeConversation("c");
  const connection = { protocol: "anthropic" as const, model: "fixture", base_url: "https://example.test", credential: { kind: "local_file" as const, key_id: "saved-key" } };
  vi.mocked(f.ports.command).mockImplementationOnce(async request => ({ settings: request.command.kind === "configure" ? request.command.settings : null }) as never);
  await f.model.configure({ version: 1, enabled: true, connection });
  f.ports.test = vi.fn(async () => { throw Object.assign(new Error("A test is already running"), { existingRequestId: "original-test", diagnostic: { code: "busy", message: "A test is already running", continuation: "inspect_original", next_reads: [] } }); });
  const original = { request_id: "original-test", version: 1, window, model_settings_version: 1, connection_digest: "digest", model: connection, kind: "connection" as const, state: "running" as const, created_at_ms: 1, updated_at_ms: 1, detail: null };
  vi.mocked(f.ports.query).mockImplementationOnce(async request => {
    expect(request.query).toEqual({ kind: "diagnostic", request_id: "original-test" });
    return { diagnostic: original } as never;
  });
  await expect(f.model.testModel("connection")).rejects.toThrow("A test is already running");
  expect(f.model.getSnapshot().diagnostics[0]).toEqual(original);
  expect(f.ports.test).toHaveBeenCalledOnce();
});

it("different original plots with the same label remain separate context sources", async () => {
  const f=fixture(); await f.model.observeConversation("c");
  const add=(operation:string,sequence:number)=>f.model.includeSource("c",{snapshot:{selection:{source:"plots",label:"Selected plot",reference:{operation_id:operation,sequence},inclusion:"summary"},title:"Selected plot",description:"",text:"summary",native_data:{},truncated:false,observations:[],evidence:[]},image_base64:null,image_mime_type:null,observations:[],error:null});
  add("first",1);add("second",1);add("first",1);
  expect(f.model.composer("c").sources.map(source=>source.reference)).toEqual([{operation_id:"first",sequence:1},{operation_id:"second",sequence:1}]);
});

it("uploads an owned attachment without changing later typing and saves its reference in the full draft", async () => {
  const f=fixture(); await f.model.observeConversation("c"); f.model.editDraft("c","Keep this message");
  await f.model.upload("c","notes.txt","text/plain","YWJj");
  expect(f.model.getSnapshot().drafts.get("c")?.text).toBe("Keep this message"); expect(f.model.attachmentsReady("c")).toBe(true);
  const asset=f.model.getSnapshot().assets.get("c")![0]; expect(f.model.draftContent("c").assets).toEqual([asset.asset_id]);
  await f.model.flushDraft("c"); const saved=vi.mocked(f.ports.command).mock.calls.at(-1)![0].command;
  expect(saved).toMatchObject({kind:"save_draft",draft:{content:{assets:[asset.asset_id]}}});
  f.model.removeAsset("c",asset.asset_id); expect(f.model.draftContent("c").assets).toEqual([]); expect(f.model.getSnapshot().assets.get("c")).toHaveLength(1);
});
it("a lost upload acknowledgement is reconciled by its persisted asset identity without uploading twice", async () => {
  const f=fixture(); await f.model.observeConversation("c");
  vi.mocked(f.ports.command).mockImplementationOnce(async request=>{if(request.command.kind!=="add_asset")throw new Error("unexpected"); f.assets([{asset_id:request.command.asset_id,name:"notes.txt",mime_type:"text/plain",bytes:3,sha256:"sha256:fixture"}]); throw new Error("ACK lost");});
  await f.model.upload("c","notes.txt","text/plain","YWJj");
  expect(f.ports.command).toHaveBeenCalledOnce(); expect(f.model.attachmentsReady("c")).toBe(true); expect(f.model.draftContent("c").assets).toHaveLength(1);
});
it("an unconfirmed upload stays removable in the retained draft and blocks sending", async () => {
  const f=fixture(); await f.model.observeConversation("c"); f.model.editDraft("c","Retain me");
  vi.mocked(f.ports.command).mockRejectedValueOnce(new Error("Upload unavailable"));
  await expect(f.model.upload("c","notes.txt","text/plain","YWJj")).rejects.toThrow("Upload unavailable");
  expect(f.model.attachmentsReady("c")).toBe(false); expect(f.model.draftContent("c").text).toBe("Retain me");
  f.model.removeAsset("c",f.model.draftContent("c").assets[0]); expect(f.model.attachmentsReady("c")).toBe(true);
});

it("archived Rho drafts are read-only while ownership still permits unarchive", async () => {
  const f=fixture(); f.remote({...conversation(),archived:true}); await f.model.observeConversation("c");
  expect(f.model.ownsTask("c")).toBe(true); expect(f.model.canControl("c")).toBe(false);
  expect(()=>f.model.editDraft("c","blocked")).toThrow("Unarchive");
  await expect(f.model.start(input)).rejects.toThrow("does not control"); expect(f.ports.command).not.toHaveBeenCalled();
  await f.model.metadata("c",{archived:false}); expect(f.model.canControl("c")).toBe(true);
  f.model.editDraft("c","Allowed after unarchive"); expect(f.model.draftContent("c").text).toBe("Allowed after unarchive");
});

it("keeps the owner's prefixed file reference while encoding the grant's raw SHA-256",async()=>{
  const f=fixture();await f.model.observeConversation("c"); const digest="a".repeat(64);
  f.model.includeSource("c",{snapshot:{selection:{source:"files",label:"notes.txt",reference:{path:"notes.txt",expected_sha256:`sha256:${digest}`},inclusion:"text"},title:"notes.txt",description:"",text:"body",native_data:{},truncated:false,observations:[],evidence:[{kind:"file",path:"notes.txt",sha256:`sha256:${digest}`}]},image_base64:null,image_mime_type:null,observations:[],error:null});
  expect(f.model.composer("c").grant.files).toEqual([{path:"notes.txt",sha256:digest}]);
  expect(f.model.composer("c").sources[0].reference).toEqual({path:"notes.txt",expected_sha256:`sha256:${digest}`});
});

it.each(["explain", "edit", "run"] as const)("a new send from a legacy %s draft uses Ask and preserves its selected targets", async mode => {
  const f=fixture();
  const digest="a".repeat(64);
  const grant={...clone(input.grant),mode,documents:[{document:{document_id:"doc",document_version:"v1",selection_version:"s1"},path:"analysis.R",allow_save:false}],files:[{path:"notes.txt",sha256:`sha256:${digest}`}]};
  const expectedGrant={...grant,permission_policy:"ask",files:[{path:"notes.txt",sha256:digest}]};
  f.remote({...conversation(),draft:"Work on these targets",draft_content:{text:"Work on these targets",assets:[],context:[]},draft_grant:grant});
  await f.model.observeConversation("c");
  expect(f.model.composer("c").grant).toEqual(expectedGrant);
  expect(f.ports.command).not.toHaveBeenCalled();
  vi.mocked(f.ports.command).mockImplementationOnce(async request=>({settings:request.command.kind==="configure"?request.command.settings:null}) as never);
  await f.model.configure({version:1,enabled:true,connection:run({...input,request_id:"fixture",conversation_version:1,window}).model});
  await f.model.send("c");
  const commands=vi.mocked(f.ports.command).mock.calls.map(([request])=>request.command);
  expect(commands.find(command=>command.kind==="save_draft")).toMatchObject({kind:"save_draft",draft:{grant:expectedGrant}});
  expect(commands.find(command=>command.kind==="start")).toMatchObject({kind:"start",request:{grant:expectedGrant}});
  expect(grant).not.toHaveProperty("permission_policy");
  expect(grant.files[0].sha256).toBe(`sha256:${digest}`);
});
it("restores and saves the current legacy composer before sending without rewriting pending requests",async()=>{
  const f=fixture(),digest="b".repeat(64);
  const grant={...clone(input.grant),mode:"explain" as const,documents:[{document:{document_id:"doc",document_version:"v1",selection_version:"s1"},path:"analysis.R",allow_save:false}],files:[{path:"notes.txt",sha256:`sha256:${digest}`}]};
  const sources=[{source:"files",label:"notes.txt",reference:{path:"notes.txt",expected_sha256:`sha256:${digest}`},inclusion:"text"}];
  const pending:ComponentAgentStart={...clone(input),conversation_id:"other",request_id:"uncertain",conversation_version:1,window,grant:clone(grant),sources:clone(sources)};
  const retained={version:1,composers:[["c",{grant,sources}]],drafts:[["c",{text:"Use these targets",assets:[],baseVersion:1,revision:2,dirty:true,conflict:null}]],pending:[{request:pending,state:"uncertain"}]};
  const original=clone(retained);
  f.local.set("/one",retained);f.model.reset();
  const expectedGrant={...grant,permission_policy:"ask",files:[{path:"notes.txt",sha256:digest}]};
  expect(f.model.composer("c")).toEqual({grant:expectedGrant,sources});
  expect(f.model.getSnapshot().pending[0].request).toEqual(pending);
  expect(f.ports.command).not.toHaveBeenCalled();
  await f.model.observeConversation("c");await f.model.flushDraft("c");
  expect(vi.mocked(f.ports.command).mock.calls[0][0].command).toMatchObject({kind:"save_draft",draft:{grant:expectedGrant,content:{text:"Use these targets",assets:[],context:sources}}});
  expect(f.model.getSnapshot().conversations.get("c")?.draft_grant).toEqual(expectedGrant);
  expect(f.model.getSnapshot().drafts.get("c")?.dirty).toBe(false);
  vi.mocked(f.ports.command).mockImplementationOnce(async request=>({settings:request.command.kind==="configure"?request.command.settings:null}) as never);
  await f.model.configure({version:1,enabled:true,connection:run({...input,request_id:"fixture",conversation_version:1,window}).model});
  await f.model.send("c");
  const command=vi.mocked(f.ports.command).mock.calls.map(([request])=>request.command).find(command=>command.kind==="start");
  expect(command).toMatchObject({kind:"start",request:{text:"Use these targets",grant:expectedGrant,sources}});
  expect(f.model.serialize().pending[0].request).toEqual(pending);
  expect(retained).toEqual(original);
});
it("Continue keeps the original legacy grant instead of adopting the next draft's permission policy",async()=>{
  const f=fixture();await f.model.observeConversation("c");
  const original:ComponentAgentStart={...clone(input),request_id:"original",conversation_version:1,window,grant:{...clone(input.grant),files:[{path:"notes.txt",sha256:`sha256:${"c".repeat(64)}`}]}};
  const previous={...run(original),state:"stopped" as const,recovery:{version:1,digest:"original-recovery",checked_at_ms:2,unresolved_mutations:0,tools:[]}};
  f.result(previous);await f.model.observeRun("run");
  vi.mocked(f.ports.command).mockImplementationOnce(async request=>({settings:request.command.kind==="configure"?request.command.settings:null}) as never);
  await f.model.configure({version:1,enabled:true,connection:previous.model});
  f.model.setComposer("c",{sources:[],grant:{...clone(input.grant),mode:"explain",permission_policy:"full_access",session:{workspace_instance_id:"other",session_id:"r-other"}}});
  f.model.editDraft("c","Continue the original task");await f.model.send("c","run");
  const command=vi.mocked(f.ports.command).mock.calls.map(([request])=>request.command).find(command=>command.kind==="start");
  expect(command?.kind).toBe("start");if(command?.kind!=="start")throw new Error("Expected continuation request");
  expect(command.request.grant).toEqual(original.grant);
  expect(command.request.grant).not.toHaveProperty("permission_policy");
  expect(command.request.continuation).toEqual({run_id:"run",recovery_digest:"original-recovery"});
  expect(previous.request).toEqual(original);
});
