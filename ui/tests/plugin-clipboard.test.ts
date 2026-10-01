import { afterEach, expect, it, vi } from "vitest";
import { PluginClipboard } from "../src/plugin-clipboard";
afterEach(() => vi.useRealTimers());

it("reserves native writing before data collection and confirms only native completion", async () => {
  let data!: Promise<Blob>, complete!: () => void;
  const copied = new Promise<void>(done => complete = done);
  const native = vi.fn((value: Promise<Blob>) => { data = value; return copied; });
  const owner = new PluginClipboard(native), copy = owner.begin();
  expect(native).toHaveBeenCalledTimes(1);
  let supplied = false; void data.then(() => supplied = true);
  await Promise.resolve(); expect(supplied).toBe(false);
  let confirmed = false;
  const result = owner.finish(copy.copy_id, "中文 αβ").then(value => { confirmed = true; return value; });
  expect((await data).size).toBe(new TextEncoder().encode("中文 αβ").length);
  expect(confirmed).toBe(false);
  expect(owner.cancel(copy.copy_id).released).toBe(false);
  await expect(owner.finish(copy.copy_id, "duplicate")).rejects.toThrow("already submitted");
  complete(); expect(await result).toEqual({ copied: true });
});
it("wrong identities and oversized content cannot fulfill the original reservation", async () => {
  let data!: Promise<Blob>;
  const owner = new PluginClipboard(value => { data = value; return value.then(() => undefined); });
  const copy = owner.begin();
  expect(() => owner.begin()).toThrow("already in progress");
  await expect(owner.finish("foreign", "text")).rejects.toThrow("no longer available");
  await expect(owner.finish(copy.copy_id, "中".repeat(400000))).rejects.toThrow("1 MiB");
  expect(owner.cancel("foreign").released).toBe(false);
  expect(owner.cancel(copy.copy_id).released).toBe(true);
  await expect(data).rejects.toThrow("before submission");
  await expect(owner.finish(copy.copy_id, "late")).rejects.toThrow("no longer available");
});
it("closure and reservation expiry reject unfinished data without publishing it", async () => {
  vi.useFakeTimers();
  let data!: Promise<Blob>;
  const owner = new PluginClipboard(value => { data = value; return value.then(() => undefined); });
  const first = owner.begin(), expired = expect(data).rejects.toThrow("before submission");
  await vi.advanceTimersByTimeAsync(60000); await expired;
  await expect(owner.finish(first.copy_id, "late")).rejects.toThrow("no longer available");
  const second = owner.begin(), closed = expect(data).rejects.toThrow("view closed");
  owner.dispose(); await closed;
  await expect(owner.finish(second.copy_id, "late")).rejects.toThrow("no longer available");
});
it("native refusal is not reported as a successful copy", async () => {
  const owner = new PluginClipboard(async () => { throw new Error("permission denied"); });
  const copy = owner.begin();
  await expect(owner.finish(copy.copy_id, "text")).rejects.toThrow("not confirmed");
  const next = owner.begin(); expect(next.copy_id).not.toBe(copy.copy_id); owner.dispose();
});
