import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HostClient } from "../src/host-client";
import type { Invocation } from "../src/generated/Invocation";

const invocation: Invocation = { client_request_id: "request-1", capability: { id: "workspace.run", version: 1 }, arguments: { code: "x <- 1" }, preconditions: [] };
const response = (value: unknown, ok = true, status = 200) => ({ ok, status, json: async () => value }) as Response;
const clients: HostClient[] = [];
it("keeps an explicit window reference in a credential-free resume URL", () => {
  const previous = location.pathname + location.search + location.hash;
  try {
    history.replaceState(null, "", "/?window=window-to-resume#token=test-launch-token");
    const host = HostClient.fromLocation(); clients.push(host);
    expect(host.windowId).toBe("window-to-resume");
    expect(location.search).toBe("?window=window-to-resume");
    expect(location.hash).toBe("");
    expect(sessionStorage.getItem("rho-window-id")).toBe("window-to-resume");
    expect(sessionStorage.getItem("rho-token")).toBe("test-launch-token");
    expect(location.href).not.toContain("test-launch-token");
    history.replaceState(null, "", "/?window=bad%20identity");
    expect(() => HostClient.fromLocation()).toThrow("invalid window identity");
  } finally {
    history.replaceState(null, "", previous);
    sessionStorage.clear();
  }
});
function client() { const host = new HostClient("test-only-token"); clients.push(host); return host; }
function pendingRead(signal?: AbortSignal | null): Promise<Response> {
  return new Promise((_resolve, reject) => {
    if (signal?.aborted) reject(signal.reason);
    else signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { for (const host of clients.splice(0)) host.stopReads(); vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it.each([
  ["Host health", (host: HostClient) => host.info()],
  ["Agent connections", (host: HostClient) => host.agentConnection()],
  ["component conversations", (host: HostClient) => host.componentQuery({ project_root: "/project", query: { kind: "conversations", after: null, limit: 32 } })],
  ["handoff receipts", (host: HostClient) => host.agentHandoffQuery({ project_root: "/project", window: { window_id: "w", incarnation: "i" }, query: { kind: "receipt", request_id: "handoff" } })],
  ["component source search", (host: HostClient) => host.componentSourceSearch({ project_root: "/project", window: { window_id: "w", incarnation: "i" }, session: null, text: "", source: "plots", limit: 10 })],
  ["application state", (host: HostClient) => host.readState("/project", "studio")],
  ["scientific query", (host: HostClient) => host.query("/project", "workspace.snapshot")],
  ["operation record", (host: HostClient) => host.getOperation("/project", "operation-1")],
  ["event page", (host: HostClient) => host.subscribe("/project", 100)],
  ["R probe", (host: HostClient) => host.probeR({ executable: "/R", ark: "/ark" })],
])("bounds %s reads to ten seconds without retrying transport", async (_label, read) => {
  const fetch = vi.fn((_url: unknown, options?: RequestInit) => pendingRead(options?.signal));
  vi.stubGlobal("fetch", fetch);
  const pending = read(client());
  const rejection = expect(pending).rejects.toThrow(/10 seconds|timed out/i);
  await vi.advanceTimersByTimeAsync(9999);
  expect(fetch.mock.calls[0][1]?.signal?.aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(1); await rejection;
  await vi.advanceTimersByTimeAsync(10000);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

it("keeps the read deadline active while response JSON is still arriving", async () => {
  vi.stubGlobal("fetch", vi.fn(async (_url: unknown, options?: RequestInit) => ({ ok: true, status: 200,
    json: () => new Promise((_resolve, reject) => options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true })) })));
  const pending = client().info(), rejection = expect(pending).rejects.toThrow(/timed out/i);
  await vi.advanceTimersByTimeAsync(10000); await rejection;
  expect(vi.getTimerCount()).toBe(0);
});

it("cancels outstanding reads on stop while retaining accepted write waits", async () => {
  let finishWrite!: (value: Response) => void;
  const fetch = vi.fn((_url: unknown, options?: RequestInit) => options?.signal ? pendingRead(options.signal)
    : new Promise<Response>((resolve) => { finishWrite = resolve; }));
  vi.stubGlobal("fetch", fetch);
  const host = client(), read = host.info(), write = host.invoke("/project", invocation, true);
  const cancelled = expect(read).rejects.toThrow(/stopped reading/i);
  host.stopReads(); await cancelled;
  expect(fetch.mock.calls[1][1]?.signal).toBeUndefined();
  finishWrite(response({ id: null, ok: true, result: { status: "accepted" } }));
  await expect(write).resolves.toEqual({ status: "accepted" });
  expect(fetch).toHaveBeenCalledTimes(2);
});

it("does not replay writes after network failure or run read timeouts against them", async () => {
  const fetch = vi.fn().mockRejectedValue(new Error("acknowledgement lost"));
  vi.stubGlobal("fetch", fetch);
  const host = client();
  await expect(host.invoke("/project", invocation, true)).rejects.toThrow("acknowledgement lost");
  await vi.advanceTimersByTimeAsync(30000);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch.mock.calls[0][1].signal).toBeUndefined();
  expect(vi.getTimerCount()).toBe(0);
});

it.each([null, [], "invalid", { ok: "true", result: null }, { ok: true }, { result: null }])(
  "rejects malformed Host reply envelope %j instead of treating it as an unreadable record", async (value) => {
    vi.stubGlobal("fetch", vi.fn(async () => response(value)));
    await expect(client().getOperation("/project", "operation-1")).rejects.toThrow();
    expect(vi.getTimerCount()).toBe(0);
  },
);

it("preserves an explicit authoritative null operation record", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => response({ id: "frame", ok: true, result: null })));
  await expect(client().getOperation("/project", "operation-1")).resolves.toBeNull();
  expect(vi.getTimerCount()).toBe(0);
});

it("propagates malformed JSON and HTTP failures with no implicit retry and releases deadlines", async () => {
  const fetch = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => { throw new SyntaxError("Unexpected EOF"); } })
    .mockResolvedValueOnce(response({ error: "not visible" }, false, 403));
  vi.stubGlobal("fetch", fetch);
  const host = client();
  await expect(host.subscribe("/project", 10)).rejects.toThrow("Unexpected EOF");
  await expect(host.subscribe("/project", 10)).rejects.toThrow("not visible");
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(0);
});

it("routes full draft/base synchronization through the dedicated application bridge boundary only", async () => {
  const fetch = vi.fn(async (_url: unknown, _options?: RequestInit) => response({ id: "frame", ok: true, result: { kind: "synced", data: {} } })); vi.stubGlobal("fetch", fetch);
  const host = client(), text = "x".repeat(512 * 1024), window = { window_id: host.windowId, incarnation: "incarnation" };
  await host.applicationBridge("/project", { kind: "sync", session: { window, bridge_token: "test-only-bridge-token" }, sync_id: "large-draft-sync", changes: { context: null, removed_documents: [], documents: [{ expected_version: null, expected_selection_version: null,
    document: { document_id: "document", version: "draft-version", path: "large.R", text, base_text: text, base_hash: `sha256:${"0".repeat(64)}`, selection: { anchor: 0, head: 0, version: "selection-version" }, readonly_reason: null } }] } });
  expect(fetch.mock.calls[0][0]).toBe("/api/application/bridge"); const options = fetch.mock.calls[0][1] as RequestInit;
  expect(new TextEncoder().encode(String(options.body)).length).toBeGreaterThan(272 * 1024);
  expect(JSON.parse(String(options.body))).toMatchObject({ project_root: "/project", frame: { request: { method: "application_bridge", params: { kind: "sync", sync_id: "large-draft-sync" } } } });
  expect(options.headers).toMatchObject({ Authorization: "Bearer test-only-token", "X-Rho-Studio-Window": host.windowId });
  await host.applicationControl("/project", { window, request_id: "ordinary-control", action: { kind: "open_view", view_type: "files", view_id: null, expected_context_version: "context" } }); expect(fetch.mock.calls[1][0]).toBe("/api/host");
  await host.invoke("/project", invocation, true); expect(fetch.mock.calls[2][0]).toBe("/api/host");
});

it("prepares masked Codex and generic MCP configuration only for this Workbench origin", () => {
  const host = client(), data = { project_root: "/project", endpoint: `${location.origin}/mcp`, suggested_server_name: "rho_12345", observed_at_ms: 1, active_sessions: 0, sessions: [], history_truncated: false };
  const preview = host.agentConfiguration(data, "codex", true);
  expect(preview).toContain("[mcp_servers.rho_12345]");
  expect(preview).not.toContain("test-only-token");
  expect(host.agentConfiguration(data, "codex", false)).toContain('Authorization = "Bearer test-only-token"');
  expect(JSON.parse(host.agentConfiguration(data, "mcp", false))).toEqual({ transport: "streamable-http", url: data.endpoint, headers: { Authorization: "Bearer test-only-token" } });
  for (const endpoint of ["https://foreign.example/mcp", `${location.origin}/mcp#token=bad`, `${location.origin}/api/host`]) {
    expect(() => host.agentConfiguration({ ...data, endpoint }, "codex", false)).toThrow("does not belong");
  }
  expect(() => host.agentConfiguration({ ...data, suggested_server_name: 'rho_12345]\nmalicious = "x"' }, "codex", false)).toThrow();
});

it("retains structured component failures without reducing recovery decisions to HTTP status", async () => {
  const diagnostic = { code: "busy", message: "A model test is already running", continuation: "inspect_original", next_reads: [] };
  vi.stubGlobal("fetch", vi.fn(async () => response({ error: "legacy detail", diagnostic, submission: "rejected", request_id: "new-test", existing_request_id: "original-test" }, false, 429)));
  await expect(client().componentModelTest({ project_root: "/study", window: { window_id: "w", incarnation: "i" }, request_id: "new-test", model_settings_version: 1, kind: "connection" })).rejects.toMatchObject({
    message: diagnostic.message, diagnostic, status: 429, submission: "rejected", requestId: "new-test", existingRequestId: "original-test",
  });
  expect(fetch).toHaveBeenCalledTimes(1);
});
