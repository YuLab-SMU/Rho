import { afterEach, expect, it, vi } from "vitest";
import { ApplicationBridge } from "../src/application-bridge";
import type { ApplicationBridgePorts, ApplicationModules, ApplicationTransport } from "../src/application-ports";
import type { ApplicationDocument } from "../src/generated/ApplicationDocument";
import type { ApplicationContextState } from "../src/generated/ApplicationContextState";
import type { ApplicationCommandGrant } from "../src/generated/ApplicationCommandGrant";
import type { ApplicationCommandReceipt } from "../src/generated/ApplicationCommandReceipt";
import type { ApplicationAction } from "../src/generated/ApplicationAction";
import type { ApplicationExecuteReply } from "../src/generated/ApplicationExecuteReply";
import type { ApplicationBridgeReply } from "../src/generated/ApplicationBridgeReply";
import type { ApplicationBridgeRequest } from "../src/generated/ApplicationBridgeRequest";
import { sha256 } from "../src/documents";

function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const disposals: (() => void)[] = [];
afterEach(() => { for (const dispose of disposals.splice(0)) dispose(); });
const reference = (d: ApplicationDocument) => ({ document_id: d.document_id, document_version: d.version, selection_version: d.selection.version });
const draft = (text = "x <- 2\n"): ApplicationDocument => ({ document_id: "d1", version: "v1", path: "analysis.R", text, base_text: "x <- 1\n", base_hash: "base-hash",
  selection: { anchor: 0, head: 0, version: "selection-1" }, readonly_reason: null });
const context = (): ApplicationContextState => ({ version: "remote-context-1", label: "Test", active_document_id: null, active_view_id: null, native_session_id: "native-1", views: [], selected_object: null, selected_package: null, selected_plot: null });

function fixture(initial: ApplicationDocument[] = [draft()], remoteInitial: ApplicationDocument[] = []) {
  let time = 1000, local = structuredClone(initial), remote = structuredClone(remoteInitial), remoteContext = context(), localContext = context();
  if (local.length) localContext.active_document_id = local[0].document_id;
  if (remote.length) remoteContext.active_document_id = remote[0].document_id;
  const scope = { epoch: 1, project: "/project", session: "native-1", runtimeState: "idle", connected: true, capabilities: ["application.context"] };
  const session = { window: { window_id: "window-1", incarnation: "life-1" }, bridge_token: "private-bridge-token" };
  const queued: ApplicationCommandGrant[] = [], receipts = new Map<string, ApplicationCommandReceipt>();
  let lastClaim: ApplicationCommandGrant | null = null, edits = 0, savedText: string | null = null;
  const summary = async (d: ApplicationDocument) => ({ document: reference(d), path: d.path, sha256: await sha256(d.text), base_hash: d.base_hash,
    base_text_present: d.base_text !== null, utf8_bytes: new TextEncoder().encode(d.text).length, dirty: d.text !== d.base_text, selection: d.selection, readonly_reason: d.readonly_reason });
  const makeReceipt = (grant: ApplicationCommandGrant, state: ApplicationCommandReceipt["state"]): ApplicationCommandReceipt => ({ window: session.window, request_id: grant.request.request_id,
    actor: { kind: "agent", id: "test-agent" }, state, created_at_ms: time, claim_expires_at_ms: time + 30000, claimed_at_ms: time,
    completed_at_ms: state === "claimed" ? null : time, context_version: remoteContext.version, capture: grant.capture, diagnostic: null,
    save: grant.request.action.kind === "run_file" || grant.request.action.kind === "save" ? { state: "not_submitted", client_request_id: "save-id", operation_id: null, error: null, verification: null } : null,
    run: grant.request.action.kind === "run_file" || grant.request.action.kind === "run_selection" ? { state: "not_submitted", client_request_id: "run-id", operation_id: null, error: null, verification: null } : null,
  });
  const transport: ApplicationTransport = {
    bridge: vi.fn(async (_project, request): Promise<ApplicationBridgeReply> => {
      if (request.kind === "register") return { kind: "registered", data: { session, context: structuredClone(remoteContext), documents: await Promise.all(remote.map(summary)), heartbeat_interval_ms: 5000, offline_after_ms: 15000 } };
      if (request.kind === "renew") return { kind: "renewed", data: { window: session.window, label: "Test", online: true, renewed_at_ms: time, lease_expires_at_ms: time + 15000, synced_at_ms: time, context_version: remoteContext.version, document_count: remote.length } };
      if (request.kind === "sync") {
        if (request.changes.context) remoteContext = structuredClone(request.changes.context.context);
        for (const { document } of request.changes.documents) remote = [...remote.filter((d) => d.document_id !== document.document_id), structuredClone(document)];
        remote = remote.filter((d) => !request.changes.removed_documents.some((r) => r.document_id === d.document_id));
        return { kind: "synced", data: { sync_id: request.sync_id, synced_at_ms: time, context_version: remoteContext.version, document_versions: request.changes.documents.map(({ document }) => reference(document)) } };
      }
      if (request.kind === "claim") {
        lastClaim = queued.shift() ?? null;
        if (lastClaim) receipts.set(lastClaim.request.request_id, makeReceipt(lastClaim, "claimed"));
        return { kind: "claimed", data: lastClaim };
      }
      const previous = receipts.get(request.completion.request_id)!;
      const receipt = { ...previous, state: request.completion.outcome === "applied" ? previous.capture ? "awaiting_execution" as const : "applied" as const : "failed" as const };
      receipts.set(receipt.request_id, receipt);
      for (const { document } of request.completion.changes.documents) remote = [...remote.filter((d) => d.document_id !== document.document_id), structuredClone(document)];
      if (request.completion.changes.context) remoteContext = structuredClone(request.completion.changes.context.context);
      return { kind: "completed", data: receipt };
    }),
    status: vi.fn(async (_project, args) => structuredClone(receipts.get(args.request_id)!)),
    execute: vi.fn(async (_project, request): Promise<ApplicationExecuteReply> => {
      const receipt = structuredClone(receipts.get(request.request_id)!);
      const step = request.step === "save" ? receipt.save! : receipt.run!;
      step.state = "succeeded"; step.operation_id = `operation-${request.step}`;
      receipt.state = request.step === "run" || !receipt.run ? "applied" : "awaiting_execution";
      receipts.set(request.request_id, receipt); return { receipt, operation: null };
    }),
    readDocument: vi.fn(async (_project, args) => {
      const document = remote.find((d) => d.document_id === args.document.document_id)!;
      const source = args.content === "base" ? document.base_text! : document.text;
      const bytes = new TextEncoder().encode(source), end = Math.min(bytes.length, args.offset_utf8 + (args.limit_bytes ?? 65536));
      return { window: session.window, document: await summary(document), source: "live_bridge", content: args.content, content_sha256: args.expected_sha256,
        text: new TextDecoder().decode(bytes.slice(args.offset_utf8, end)), offset_utf8: args.offset_utf8, next_offset_utf8: end < bytes.length ? end : null, synced_at_ms: time };
    }),
  };
  const check: ApplicationModules["checkDocument"] = (r) => { if (!local.some((d) => JSON.stringify(reference(d)) === JSON.stringify(r))) throw new Error("document changed"); };
  const modules: ApplicationModules = {
    context: () => structuredClone(localContext), documents: () => structuredClone(local),
    restoreDocuments: vi.fn((documents, active) => { local = structuredClone([...documents]); localContext.active_document_id = active; }),
    restoreViews: vi.fn((desired) => { localContext = structuredClone(desired()); }),
    openView: vi.fn(), activateView: vi.fn(), closeView: vi.fn(), openDocument: vi.fn(async () => {}), createDocument: vi.fn(), checkDocument: check,
    setSelection: vi.fn(), selectObject: vi.fn(), selectPackage: vi.fn(), selectPlot: vi.fn(),
    editDocument: vi.fn((r, changes) => { check(r); edits++; const d = local.find((d) => d.document_id === r.document_id)!; for (const change of [...changes].reverse()) d.text = d.text.slice(0, change.from) + change.insert + d.text.slice(change.to); d.version = crypto.randomUUID(); d.selection.version = crypto.randomUUID(); }),
    confirmSave: vi.fn((id, captured, path, digest) => { const d = local.find((d) => d.document_id === id)!; d.base_text = captured; d.path = path; d.base_hash = digest; d.version = crypto.randomUUID(); savedText = captured; }),
  };
  const ports: ApplicationBridgePorts = { scope: () => scope, transport, modules, identity: { windowId: "window-1", incarnation: "life-1" }, registered: vi.fn(), reportError: vi.fn(), now: () => time };
  const bridge = new ApplicationBridge(ports); disposals.push(() => bridge.stop());
  const queue = async (action: ApplicationAction) => {
    const document = "document" in action ? local.find((d) => d.document_id === action.document.document_id)! : null;
    const scientific = ["save", "run_file", "run_selection"].includes(action.kind);
    const grant: ApplicationCommandGrant = { request: { window: session.window, request_id: crypto.randomUUID(), action }, claim_id: crypto.randomUUID(), execution_ref: scientific ? "capture-association" : null,
      capture: scientific && document ? { document: reference(document), path: document.path, base_hash: document.base_hash, sha256: await sha256(document.text), utf8_bytes: new TextEncoder().encode(document.text).length,
        run_sha256: action.kind === "save" ? null : await sha256(document.text), native_session_id: "native-1", selection: document.selection } : null };
    queued.push(grant); return grant;
  };
  return { bridge, ports, transport, modules, scope, queue, receipts, local: () => local, remote: () => remote, edits: () => edits, savedText: () => savedText,
    localContext: () => localContext, remoteContext: () => remoteContext,
    setLocalContext: (patch: Partial<ApplicationContextState>) => { localContext = { ...localContext, ...patch }; },
    setRemoteContext: (patch: Partial<ApplicationContextState>) => { remoteContext = { ...remoteContext, ...patch }; },
    advance: (ms: number) => { time += ms; }, type: (text: string) => { local[0].text = text; local[0].version = crypto.randomUUID(); local[0].selection.version = crypto.randomUUID(); } };
}

it("applies a versioned edit without any mounted panel and rejects later stale commands", async () => {
  const f = fixture(); await f.bridge.start();
  const old = reference(f.local()[0]);
  await f.queue({ kind: "edit_document", document: old, edits: [{ from: 5, to: 6, insert: "9" }] });
  await f.bridge.step(); expect(f.local()[0].text).toBe("x <- 9\n"); expect(f.edits()).toBe(1);
  await f.queue({ kind: "edit_document", document: old, edits: [{ from: 5, to: 6, insert: "0" }] });
  await f.bridge.step(); expect(f.edits()).toBe(1); expect(f.bridge.getSnapshot().receipt?.state).toBe("failed");
});
it("reconciles a lost completion acknowledgement without repeating the local edit", async () => {
  const f = fixture(); await f.bridge.start(); const original = f.transport.bridge;
  let lost = true;
  f.transport.bridge = vi.fn(async (project, request) => { const reply = await original(project, request); if (request.kind === "complete" && lost) { lost = false; throw new Error("acknowledgement lost"); } return reply; });
  await f.queue({ kind: "edit_document", document: reference(f.local()[0]), edits: [{ from: 5, to: 6, insert: "8" }] });
  await f.bridge.step(); await f.bridge.step();
  expect(f.edits()).toBe(1); expect(f.transport.status).toHaveBeenCalledTimes(1); expect(f.bridge.getSnapshot().receipt?.state).toBe("applied");
});
it("preserves keystrokes made while a captured application CAS write is waiting", async () => {
  const f = fixture(); await f.bridge.start(); f.type("captured first\n"); f.advance(500);
  const original = f.transport.bridge, delay = deferred<ApplicationBridgeReply>(); let capturedRequest: ApplicationBridgeRequest | null = null;
  f.transport.bridge = vi.fn((project, request) => { if (request.kind === "sync") { capturedRequest = request; return delay.promise; } return original(project, request); });
  const writing = f.bridge.step(); await Promise.resolve(); f.type("later user input\n");
  expect(capturedRequest?.kind).toBe("sync"); delay.resolve(await original("/project", capturedRequest!)); await writing;
  expect(f.local()[0].text).toBe("later user input\n");
  f.transport.bridge = original; f.advance(500); await f.bridge.step(); expect(f.remote()[0].text).toBe("later user input\n");
});
it("restores the exact draft and independent disk base through paged owner reads", async () => {
  const d = draft("a".repeat(90000)); d.base_text = "old disk base\n"; d.base_hash = await sha256(d.base_text);
  const f = fixture([], [d]); await f.bridge.start();
  expect(f.local()[0]).toMatchObject({ text: d.text, base_text: d.base_text, base_hash: d.base_hash });
  expect(vi.mocked(f.transport.readDocument).mock.calls.map(([, args]) => [args.content, args.offset_utf8])).toEqual([["draft", 0], ["draft", 65536], ["base", 0]]);
});
it("retains local input during restoration and synchronizes it against the observed remote version", async () => {
  const f = fixture([draft("local")], [draft("remote")]); const original = f.transport.readDocument, delay = deferred<void>();
  f.transport.readDocument = vi.fn(async (...args) => { await delay.promise; return original(...args); });
  const starting = f.bridge.start(); for (let i = 0; i < 20; i++) await Promise.resolve(); f.type("input during restore"); delay.resolve(); await starting;
  expect(f.local()[0].text).toBe("input during restore"); expect(f.remote()[0].text).toBe("input during restore"); expect(f.bridge.ready).toBe(true);
  const request = vi.mocked(f.transport.bridge).mock.calls.find(([, request]) => request.kind === "sync")![1];
  expect(request.kind === "sync" && request.changes.documents[0]).toMatchObject({ expected_version: "v1", expected_selection_version: "selection-1" });
});
it("preserves a view opened after persistence but before bridge registration with no documents", async () => {
  const f = fixture([], []), consoleView = { view_id: "console", view_type: "console", document_id: null, active: true } as const;
  f.setLocalContext({ views: [consoleView], active_view_id: "console" });
  f.setRemoteContext({ views: [consoleView], active_view_id: "console" });
  f.bridge.prepareRestore();
  const packages = { view_id: "packages", view_type: "packages", document_id: null, active: true } as const;
  f.setLocalContext({ views: [consoleView, packages], active_view_id: "packages" });
  await f.bridge.start();
  expect(f.localContext().views).toContainEqual(packages); expect(f.localContext().active_view_id).toBe("packages");
  expect(f.remoteContext().active_view_id).toBe("packages"); expect(f.bridge.ready).toBe(true);
});
it("resolves current view intent after delayed evidence and never reopens a newly closed view", async () => {
  const f = fixture([], []), consoleView = { view_id: "console", view_type: "console", document_id: null, active: true } as const;
  const packages = { view_id: "packages", view_type: "packages", document_id: null, active: true } as const;
  f.setLocalContext({ views: [consoleView, packages], active_view_id: "packages" });
  f.setRemoteContext({ views: [consoleView, packages], active_view_id: "packages" });
  const delayed = deferred<void>(), entered = deferred<void>();
  f.modules.restoreViews = vi.fn(async (desired) => { entered.resolve(); await delayed.promise; f.setLocalContext(desired()); });
  const starting = f.bridge.start(); await entered.promise;
  f.setLocalContext({ views: [consoleView], active_view_id: "console" }); delayed.resolve(); await starting;
  expect(f.localContext().views).toEqual([consoleView]); expect(f.remoteContext().views).toEqual([consoleView]);
  expect(f.bridge.ready).toBe(true); expect(f.ports.reportError).not.toHaveBeenCalled();
});
it("restores unrelated remote drafts while retaining only the draft edited during the read", async () => {
  const first = draft("old first"), other = { ...draft("remote second"), document_id: "d2", path: "other.R" };
  const f = fixture([first], [draft("remote first"), other]), entered = deferred<void>(), delayed = deferred<void>();
  const read = f.transport.readDocument;
  f.transport.readDocument = vi.fn(async (...args) => { entered.resolve(); await delayed.promise; return read(...args); });
  const starting = f.bridge.start(); await entered.promise; f.type("user first"); delayed.resolve(); await starting;
  expect(f.local().find((d) => d.document_id === "d1")?.text).toBe("user first");
  expect(f.local().find((d) => d.document_id === "d2")?.text).toBe("remote second");
  expect(f.remote().find((d) => d.document_id === "d1")?.text).toBe("user first"); expect(f.bridge.ready).toBe(true);
});
it("native observation handle refreshes do not block draft restoration", async () => {
  const f = fixture([], [draft("remote")]), entered = deferred<void>(), delayed = deferred<void>();
  f.setLocalContext({ selected_object: { name: "data", native_session_id: "native-1", object_ref: "old-observation" } });
  const read = f.transport.readDocument;
  f.transport.readDocument = vi.fn(async (...args) => { entered.resolve(); await delayed.promise; return read(...args); });
  const starting = f.bridge.start(); await entered.promise;
  f.setLocalContext({ selected_object: { name: "data", native_session_id: "native-1", object_ref: "new-observation" } });
  delayed.resolve(); await starting; expect(f.local()[0].text).toBe("remote"); expect(f.bridge.ready).toBe(true);
});
it("saves one captured version while keeping subsequent input dirty and never runs after disconnect", async () => {
  const f = fixture(); await f.bridge.start(); const grant = await f.queue({ kind: "run_file", document: reference(f.local()[0]), target_path: null });
  await f.bridge.step(); const savedCapture = f.local()[0].text;
  const original = f.transport.execute, delay = deferred<ApplicationExecuteReply>(); f.transport.execute = vi.fn(() => delay.promise);
  const saving = f.bridge.step(); await Promise.resolve(); f.type("newer unsaved input\n"); f.scope.connected = false; f.bridge.disconnected();
  delay.resolve(await original("/project", { session: { window: grant.request.window, bridge_token: "private-bridge-token" }, request_id: grant.request.request_id, execution_ref: grant.execution_ref!, step: "save" })); await saving;
  f.scope.connected = true; await f.bridge.step();
  expect(f.savedText()).toBe(savedCapture); expect(f.local()[0].text).toBe("newer unsaved input\n"); expect(f.local()[0].base_text).toBe(savedCapture);
  expect(vi.mocked(f.transport.execute).mock.calls.map(([, request]) => request.step)).toEqual(["save"]);
  expect(f.receipts.get(grant.request.request_id)?.run?.state).toBe("not_submitted");
});
it("renews the window lease independently while an accepted scientific response waits", async () => {
  const f = fixture(); await f.bridge.start(); await f.queue({ kind: "run_selection", document: reference(f.local()[0]) }); await f.bridge.step();
  const wait = deferred<ApplicationExecuteReply>(); f.transport.execute = vi.fn(() => wait.promise);
  const running = f.bridge.step(); await Promise.resolve(); f.advance(6000); await f.bridge.heartbeat();
  expect(vi.mocked(f.transport.bridge).mock.calls.some(([, request]) => request.kind === "renew")).toBe(true);
  wait.reject(new Error("transport disconnected")); await running;
});
it("a native-session observation change does not recreate the application window or discard drafts", async () => {
  const f = fixture(); await f.bridge.start(); f.type("retained after R restart\n"); f.scope.epoch++; f.scope.session = "native-2"; f.advance(500); await f.bridge.step();
  expect(vi.mocked(f.transport.bridge).mock.calls.filter(([, request]) => request.kind === "register")).toHaveLength(1);
  expect(f.local()[0].text).toBe("retained after R restart\n");
});
