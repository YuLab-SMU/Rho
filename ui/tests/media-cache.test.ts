import { expect, it, vi } from "vitest";
import { MediaCache } from "../src/media-cache";
import type { MediaReference } from "../src/generated/MediaReference";
import type { QuerySnapshot } from "../src/generated/QuerySnapshot";
import type { RequestContext } from "../src/shared/ports";
const reference = (id = "one", size = 2): MediaReference => ({ operation_id: id, sequence: 1, mime_type: "image/png", byte_size: size, sha256: `sha256:${"a".repeat(64)}`, display_id: null });
const page = (ref: MediaReference, bytes = [1, 2], offset = 0, has_more = false): QuerySnapshot => ({ target: { kind: "workspace", identity: "/project" }, source: "test", observed_at_ms: 1, status: "ready", completeness: "complete", data: { reference: ref, bytes, offset, has_more }, notices: [] });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((yes) => { resolve = yes; }); return { promise, resolve }; }
function fixture(budgetBytes?: number) {
  let context: RequestContext = { epoch: 1, project: "/project", session: null, runtimeState: null, connected: true, capabilities: [] }, now = 0;
  const query = vi.fn(), adapter = { sha256: vi.fn(async () => reference().sha256), createUrl: vi.fn((_bytes, _mime) => `blob:${adapter.createUrl.mock.calls.length}`), revokeUrl: vi.fn() };
  const cache = new MediaCache({ context: () => context, query, adapter, budgetBytes, now: () => now });
  return { cache, query, adapter, advance: () => { now += 500; }, context: (value: Partial<RequestContext>) => { context = { ...context, ...value }; } };
}
it("coalesces Console and Plots requests into one validated original and retains export after decode failure", async () => {
  const f = fixture(), ref = reference(); f.query.mockResolvedValue(page(ref));
  f.cache.load(ref); f.cache.load({ ...ref }); await f.cache.step();
  expect(f.query).toHaveBeenCalledTimes(1);
  expect(f.adapter.sha256.mock.calls[0][0]).toEqual(new Uint8Array([1, 2]));
  const url = f.cache.getSnapshot().urls.get(f.cache.key(ref));
  f.cache.reportDecodeError(ref);
  expect(f.cache.getSnapshot().urls.get(f.cache.key(ref))).toBe(url);
  expect(f.cache.getSnapshot().errors.get(f.cache.key(ref))).toMatch(/decode/);
  f.cache.retry(ref);
  expect(f.cache.getSnapshot().errors.size).toBe(0);
  expect(f.query).toHaveBeenCalledTimes(1);
});
it("retries the exact failed media chunk and never publishes partial bytes", async () => {
  const f = fixture(), ref = reference("large", 65538);
  f.query.mockResolvedValueOnce(page(ref, Array(65536).fill(1), 0, true)).mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(page(ref, [2, 3], 65536));
  f.cache.load(ref); await f.cache.step(); await f.cache.step();
  expect(f.cache.getSnapshot().urls.size).toBe(0);
  f.advance(); await f.cache.step();
  expect(f.query.mock.calls.map((call) => call[2].offset)).toEqual([0, 65536, 65536]);
  expect(f.cache.getSnapshot().byteSize).toBe(65538);
});
it("rejects changed chunk identities and checksum failures without creating a URL", async () => {
  const f = fixture(), ref = reference();
  f.query.mockResolvedValueOnce(page({ ...ref, display_id: "other" }));
  f.cache.load(ref); await f.cache.step();
  expect(f.cache.getSnapshot().errors.get(f.cache.key(ref))).toMatch(/identity/);
  expect(f.adapter.createUrl).not.toHaveBeenCalled();
  f.advance(); f.query.mockResolvedValue(page(ref)); f.adapter.sha256.mockResolvedValueOnce("sha256:wrong");
  await f.cache.step();
  expect(f.cache.getSnapshot().errors.get(f.cache.key(ref))).toMatch(/checksum/);
  expect(f.adapter.createUrl).not.toHaveBeenCalled();
  f.cache.retry(ref); await f.cache.step();
  expect(f.cache.getSnapshot().urls.size).toBe(1);
});
it("receives protected references without a layout dependency and releases every URL on stop", async () => {
  const f = fixture(4), refs = [reference("one"), reference("two"), reference("three")];
  f.query.mockImplementation(async (_project, _id, args) => page(args.reference));
  f.cache.protect(new Set([f.cache.key(refs[0])]));
  for (const ref of refs) { f.cache.load(ref); await f.cache.step(); f.advance(); }
  expect(f.cache.getSnapshot().urls.has(f.cache.key(refs[0]))).toBe(true);
  expect(f.cache.getSnapshot().urls.has(f.cache.key(refs[1]))).toBe(false);
  expect(f.adapter.revokeUrl).toHaveBeenCalledTimes(1);
  f.cache.stop();
  expect(f.adapter.revokeUrl).toHaveBeenCalledTimes(3);
  expect(f.cache.getSnapshot().urls.size).toBe(0);
});
it("discards a checksum completion after A-to-B-to-A or stopping the client", async () => {
  const f = fixture(), ref = reference(), hash = deferred<string>();
  f.query.mockResolvedValue(page(ref)); f.adapter.sha256.mockReturnValueOnce(hash.promise);
  f.cache.load(ref); const loading = f.cache.step();
  await Promise.resolve();
  f.context({ epoch: 2, project: "/other" }); f.cache.reset();
  f.context({ epoch: 3, project: "/project" }); f.cache.reset();
  hash.resolve(ref.sha256); await loading;
  expect(f.adapter.createUrl).not.toHaveBeenCalled();
  expect(f.cache.getSnapshot().urls.size).toBe(0);
  f.cache.stop();
});

it("keeps validated historical originals across native restart and ignores an old image's decode failure", async () => {
  const f = fixture(), ref = reference(); f.query.mockResolvedValue(page(ref));
  f.cache.load(ref); await f.cache.step();
  const url = f.cache.getSnapshot().urls.get(f.cache.key(ref));
  f.context({ epoch: 2, session: "restarted" }); f.cache.sessionChanged();
  expect(f.cache.getSnapshot().urls.get(f.cache.key(ref))).toBe(url);
  f.cache.reportDecodeError(ref, "blob:old");
  expect(f.cache.getSnapshot().errors.size).toBe(0);
  expect(f.adapter.revokeUrl).not.toHaveBeenCalled();
});
