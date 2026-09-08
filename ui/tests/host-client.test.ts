import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HostClient } from "../src/host-client";
import type { Invocation } from "../src/generated/Invocation";

const invocation: Invocation = { client_request_id: "request-1", capability: { id: "workspace.run", version: 1 }, arguments: { code: "x <- 1" }, preconditions: [] };
const response = (value: unknown, ok = true, status = 200) => ({ ok, status, json: async () => value }) as Response;
const clients: HostClient[] = [];
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
