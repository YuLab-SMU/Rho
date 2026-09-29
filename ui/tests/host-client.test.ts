import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HostClient, HostPortError } from "../src/host-client";
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
it("constructs only a same-Host private test URL and severs the opener", () => {
  const host = new HostClient("private-launch-token", "parent-window"); clients.push(host);
  const target = { opener: window, document: document.implementation.createHTMLDocument(), close: vi.fn() };
  const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  const open = vi.fn(() => target as unknown as Window);
  expect(host.openTestWorkspace("test-child", "parent-window", open)).toEqual({ navigation_requested: true });
  const link = target.document.querySelector('a')!, address = new URL(link.href);
  expect(address.origin).toBe(location.origin); expect(address.pathname).toBe("/");
  expect(address.searchParams.get("window")).toBe("parent-window"); expect(address.searchParams.get("test-project")).toBe("test-child");
  expect(address.searchParams.has("plugin-window")).toBe(true); expect(new URLSearchParams(address.hash.slice(1)).get("token")).toBe("private-launch-token");
  expect(target.opener).toBeNull(); expect(link.rel).toContain("noreferrer"); expect(link.referrerPolicy).toBe("no-referrer");
  expect(click).toHaveBeenCalledOnce();
  for (const id of ["", "bad..id", "https://outside.invalid"]) expect(() => host.openTestWorkspace(id, "parent-window", open)).toThrow();
  expect(() => host.openTestWorkspace("test-child", "another-window", open)).toThrow();
  expect(() => new HostClient("private-launch-token", "parent-window", "original-child").openTestWorkspace("test-child", "parent-window", open)).toThrow();
  expect(open).toHaveBeenCalledTimes(1); click.mockRestore();
});
it("keeps ending-document Control delivery on the authenticated selected Host port", async () => {
  const fetch = vi.fn(async (_url: unknown, options?: RequestInit) => {
    const { frame } = JSON.parse(String(options?.body));
    return response({ id: frame.id, ok: true, result: { released: true } });
  });
  vi.stubGlobal("fetch", fetch);
  const host = new HostClient("test-only-token", "ending-window", "test-child"); clients.push(host);
  await host.port("/analysis", { method: "control", params: { capability: { id: "views.release_renderer", version: 1 }, arguments: {} } }, host.testProject!, true);
  const [url, options] = fetch.mock.calls[0]!;
  expect(url).toBe("/api/host"); expect(options?.keepalive).toBe(true); expect(options?.signal).toBeUndefined();
  expect(options?.headers).toMatchObject({ Authorization: "Bearer test-only-token", "X-Rho-Studio-Window": "ending-window" });
  expect(JSON.parse(String(options?.body))).toMatchObject({ project_root: "/analysis", frame: { test_project: "test-child", request: { method: "control" } } });
});
it('retains structured port rejection only when correlated to the original request', async () => {
  const diagnostic = { code: 'invalid_input', message: 'Close handler is unavailable', continuation: 'correct_input', next_reads: [] };
  const fetch = vi.fn(async (_url: unknown, options?: RequestInit) => {
    const { frame } = JSON.parse(String(options?.body));
    return response({ id: frame.id, ok: false, diagnostic });
  });
  vi.stubGlobal('fetch', fetch);
  await expect(client().invoke('/project', invocation)).rejects.toMatchObject({
    name: 'HostPortError', diagnostic, request: { method: 'invoke', params: invocation },
  });
  fetch.mockImplementation(async () => response({ id: 'another-frame', ok: false, diagnostic, error: 'Uncorrelated failure' }));
  const rejected = await client().invoke('/project', invocation).catch(error => error);
  expect(rejected).not.toBeInstanceOf(HostPortError); expect(rejected.message).toBe('Uncorrelated failure');
});
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
  ["application state", (host: HostClient) => host.readState("/project", "studio")],
  ["scientific query", (host: HostClient) => host.query("/project", "workspace.snapshot")],
  ["operation record", (host: HostClient) => host.getOperation("/project", "operation-1")],
  ["event page", (host: HostClient) => host.subscribe("/project", 100)],
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

it('keeps a test selection across refresh without replacing the parent window or credentials', async () => {
  const previous = location.pathname + location.search + location.hash;
  try {
    sessionStorage.setItem('rho-window-id', 'parent-window');
    history.replaceState(null, '', '/?test-project=test-one&window=test-window#token=private-test-launch');
    const host = HostClient.fromLocation(); clients.push(host);
    expect(host.testProject).toBe('test-one'); expect(host.windowId).toBe('test-window');
    expect(location.hash).toBe(''); expect(location.search).toContain('test-project=test-one');
    expect(sessionStorage.getItem('rho-window-id')).toBe('parent-window');
    const resumed = HostClient.fromLocation(); clients.push(resumed);
    expect(resumed.testProject).toBe('test-one'); expect(resumed.windowId).toBe('test-window');
    for (const query of ['test-project=', 'test-project=../bad', 'test-project=UPPER', 'test-project=a&test-project=b']) {
      history.replaceState(null, '', `/?${query}`);
      expect(() => HostClient.fromLocation()).toThrow(/test project/);
    }
  } finally { history.replaceState(null, '', previous); sessionStorage.clear(); }
});

it('routes shared ports and view assets to the exact child and reads lifecycle only from the parent', async () => {
  const host = new HostClient('test-only-token', 'window', 'test-one'); clients.push(host);
  const observation = { project: { id: 'test-one', state: 'ready' }, observed_in_this_host: true };
  const fetch = vi.fn(async (_path: unknown, options?: RequestInit) => {
    const body = JSON.parse(String(options?.body));
    return response({ id: body.frame?.id, ok: true, result: { status: "ready", data: observation } });
  }); vi.stubGlobal('fetch', fetch);
  await host.query('/parent', 'plugins.instances', { limit: 100 });
  expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toMatchObject({ project_root: '/parent', frame: { test_project: 'test-one' } });
  await expect(host.testProjectObservation('/parent')).resolves.toEqual(observation);
  expect(JSON.parse(String(fetch.mock.calls[1][1]?.body)).frame).not.toHaveProperty('test_project');
  await host.request('/api/plugin-view', { test_project: 'forged', message: {} });
  expect(JSON.parse(String(fetch.mock.calls[2][1]?.body)).test_project).toBe('test-one');
  expect(host.pluginAssetUrl('connection', 'secret', 'dist/中文.html')).toBe('/view/plugin-test/test-one/connection/secret/dist/%E4%B8%AD%E6%96%87.html');
  expect(new URL('./chunk.js', 'http://localhost' + host.pluginAssetUrl('connection', 'secret', 'dist/index.html')).pathname).toBe('/view/plugin-test/test-one/connection/secret/dist/chunk.js');
  observation.observed_in_this_host = false;
  await expect(host.testProjectObservation('/parent')).rejects.toThrow('unavailable');
  for (const path of ['/api/r', '/api/project', '/api/application/bridge', '/api/agents/tasks/command'])
    await expect(host.request(path, {})).rejects.toThrow('unavailable');
  expect(fetch).toHaveBeenCalledTimes(4);
});
