import { afterEach, expect, it, vi } from "vitest";
import { HostClient } from "../src/host-client";

afterEach(() => vi.unstubAllGlobals());
it("retains the native rejection when an unsuccessful Host reply omits result", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ ok: false, error: "application budget exhausted: 32 windows per principal and project" }) })));
  const client = new HostClient("fixture", "window");
  await expect(client.query("/project", "project.storage_status", {})).rejects.toThrow("32 windows per principal and project");
});
it("still rejects malformed successful Host replies without a result", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ ok: true }) })));
  const client = new HostClient("fixture", "window");
  await expect(client.query("/project", "project.storage_status", {})).rejects.toThrow("Invalid Host reply");
});
