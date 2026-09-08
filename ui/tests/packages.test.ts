import { expect, it, vi } from "vitest";
import { Packages, packageLink } from "../src/packages";
import type { ResourceIdentity } from "../src/resource-ports";
import type { PackageSnapshotData } from "../src/generated/PackageSnapshotData";
import type { PackageGroup } from "../src/generated/PackageGroup";
const group = (
  name: string,
  extra: Partial<PackageGroup> = {},
): PackageGroup => ({
  name,
  title: `Purpose of ${name}`,
  version: "1.0",
  first_version: "1.0",
  primary_library_path: "/lib",
  copy_count: 1,
  loaded_version: null,
  loaded_path: null,
  loaded_copy_observed: false,
  attached: false,
  source_kind: "CRAN",
  source_count: 1,
  ...extra,
});
function fixture() {
  let scope: ResourceIdentity = { epoch: 1, project: "/project", session: "session-a", runtimeState: "idle",
    connected: true, capabilities: ["workspace.packages"] };
  const query = vi.fn();
  const packages = new Packages({ context: () => scope, query, schedule: vi.fn(), changed: vi.fn() });
  packages.setVisible("fixture", true);
  const data: PackageSnapshotData = {
    r_version: "4.5.2",
    r_home: "/R",
    platform: "test",
    library_paths: ["/lib"],
    libraries: [{ index: 1, path: "/lib", status: "readable", notice: null }],
    mode: "installed",
    filter: "",
    offset: 0,
    next_offset: null,
    packages: [],
    groups: [
      group("stats", { attached: true, loaded_version: "1.0" }),
      group("tibble", { copy_count: 2 }),
    ],
    counts: {
      all: 2,
      installed: 2,
      installations: 3,
      loaded: 1,
      attached: 1,
      multiple: 1,
    },
    observation_id: "packages_1",
    observed_at_ms: 123,
    package_name: null,
    scanned: 3,
    scan_complete: true,
    total_matches: 2,
    notices: [],
  };
  const response = {
    target: { kind: "workspace", identity: "session-a" },
    status: "ready" as const,
    source: "test",
    observed_at_ms: 123,
    completeness: "partial" as const,
    data,
    notices: [],
  };
  query.mockResolvedValue(response);
  return { p: packages, response, query, scope: (change: Partial<ResourceIdentity>) => { scope = { ...scope, ...change }; } };
}
it("filters a pinned observation while busy without making another native request", async () => {
  const { p, query, scope } = fixture(); p.select("stats"); await p.observe();
  expect(query).toHaveBeenCalledWith("/project", "workspace.packages", {
    expected_session: "session-a", filter: "", mode: "installed", grouped: true, observation_id: null, package_name: null, limit: 200, offset: 0,
  });
  const data = p.data; scope({ runtimeState: "busy" }); p.select("Purpose of tibble"); await p.observe();
  expect(query).toHaveBeenCalledTimes(1); expect(p.data).toBe(data); expect(p.filtered.map((g) => g.name)).toEqual(["tibble"]);
  p.select("", "multiple"); expect(p.filtered.map((g) => g.name)).toEqual(["tibble"]);
  p.select("", "attached"); expect(p.filtered.map((g) => g.name)).toEqual(["stats"]); expect(p.observedAt).toBe(123);
});
it("drops a late observation after runtime switch", async () => {
  const { p, query, response, scope } = fixture(); let finish!: (value: unknown) => void;
  query.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  const pending = p.observe(); scope({ session: "session-b" }); p.sessionChanged(); finish(response); await pending;
  expect(p.data).toBeNull(); expect(p.observedAt).toBeNull(); expect(p.loading).toBe(false);
});
it("does not hide a post-run invalidation behind a pending observation", async () => {
  const { p, query, response } = fixture(); let finish!: (value: unknown) => void;
  query.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  const pending = p.observe(); p.invalidate(); finish(response); await pending;
  expect(p.dirty).toBe(true); expect(p.stale).toBe(true);
});
it("does not start or query R when no session exists", async () => {
  const { p, query, scope } = fixture(); scope({ session: null, runtimeState: null }); await p.observe(); expect(query).not.toHaveBeenCalled();
});
it("yields after one page, retains the same observation and preserves a newer filter", async () => {
  const { p, query, response } = fixture(); p.setVisible("packages", true);
  query.mockResolvedValueOnce({ ...response, data: { ...response.data, groups: [response.data.groups[0]], next_offset: 1 } });
  query.mockImplementationOnce(async (_p, _id, args) => {
    expect(args).toMatchObject({ observation_id: "packages_1", offset: 1 }); p.select("tibble");
    return { ...response, data: { ...response.data, groups: [response.data.groups[1]], offset: 1 } };
  });
  await p.observe(); expect(query).toHaveBeenCalledTimes(1); expect(p.completeIndex).toBe(false);
  await p.observe(); expect(p.completeIndex).toBe(true); expect(p.filtered.map((g) => g.name)).toEqual(["tibble"]); expect(p.observedAt).toBe(123);
});
it("network failure retries the exact page and original observation", async () => {
  const { p, query, response } = fixture();
  query.mockResolvedValueOnce({ ...response, data: { ...response.data, groups: [response.data.groups[0]], next_offset: 1 } });
  query.mockRejectedValueOnce(new Error("network interrupted"));
  query.mockResolvedValueOnce({ ...response, data: { ...response.data, groups: [response.data.groups[1]], offset: 1 } });
  await p.observe(); await expect(p.observe()).rejects.toThrow("network interrupted");
  const original = query.mock.calls[1][2]; expect(p.next).toBe(1); expect(p.groups.size).toBe(1); expect(p.expired).toBe(false);
  await p.observe(); expect(query.mock.calls[2][2]).toBe(original); expect(p.completeIndex).toBe(true); expect(p.observedAt).toBe(123);
});
it("expired partial indexes retain their identity until explicit Refresh", async () => {
  const { p, query, response } = fixture();
  query.mockResolvedValueOnce({ ...response, data: { ...response.data, groups: [response.data.groups[0]], next_offset: 1 } });
  query.mockRejectedValueOnce(new Error("Package observation expired"));
  await p.observe(); await p.observe(); expect(p.groups.size).toBe(1); expect(p.completeIndex).toBe(false); expect(p.expired).toBe(true);
  p.invalidate(); await p.observe(); p.retry(); await p.observe(); expect(query).toHaveBeenCalledTimes(2); expect(p.data?.observation_id).toBe("packages_1");
  p.requestRefresh(); await p.observe(); expect(query.mock.calls[2][2]).toMatchObject({ observation_id: null, offset: 0 }); expect(p.expired).toBe(false);
});
it("keeps global counts distinct from search matches and loaded pages", async () => {
  const { p } = fixture(); await p.observe(); p.select("not-present");
  expect(p.filtered).toHaveLength(0); expect(p.data!.counts.all).toBe(2); expect(p.data!.counts.installations).toBe(3);
});
it("uses exact package identity and observation id for copy inspection", async () => {
  const { p, query, response } = fixture(); await p.observe();
  query.mockResolvedValueOnce({ ...response, data: { ...response.data, groups: [], packages: [], package_name: "tibble", total_matches: 0 } });
  p.inspect("tibble"); await p.observe();
  expect(query).toHaveBeenLastCalledWith("/project", "workspace.packages", expect.objectContaining({ package_name: "tibble", observation_id: "packages_1", offset: 0, limit: 20 }));
  expect(p.details.get("tibble")?.notice).toBe("");
});
it("copy-detail network recovery retains copies and the original offset", async () => {
  const { p, query, response } = fixture(); await p.observe();
  const copy = { name: "tibble", version: "1", library_path: "/one" };
  query.mockResolvedValueOnce({ ...response, data: { ...response.data, groups: [], packages: [copy], package_name: "tibble", total_matches: 2, next_offset: 1 } });
  p.inspect("tibble"); await p.observe();
  query.mockRejectedValueOnce(new Error("temporary network failure")); p.inspect("tibble", true); await expect(p.observe()).rejects.toThrow("network");
  expect(p.details.get("tibble")?.copies).toHaveLength(1); const original = query.mock.calls[2][2];
  query.mockResolvedValueOnce({ ...response, data: { ...response.data, groups: [], packages: [{ ...copy, library_path: "/two" }],
    package_name: "tibble", total_matches: 2, offset: 1, next_offset: null } });
  await p.observe(); expect(query.mock.calls[3][2]).toBe(original); expect(p.details.get("tibble")?.copies).toHaveLength(2);
});
it("A → B → A discards both stale errors and their loading cleanup", async () => {
  const { p, query, scope, response } = fixture(); let reject!: (error: Error) => void, finish!: (value: unknown) => void;
  query.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; })); const old = p.observe();
  scope({ epoch: 2, project: "/other" }); p.reset(); scope({ epoch: 3, project: "/project" }); p.reset();
  query.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; })); const fresh = p.observe();
  reject(new Error("old project failure")); await old; expect(p.notice).toBe(""); expect(p.loading).toBe(true);
  finish(response); await fresh; expect(p.data?.observation_id).toBe("packages_1"); expect(p.loading).toBe(false);
});
it("late copy failures cannot contaminate the next native session", async () => {
  const { p, query, response, scope } = fixture(); await p.observe(); let reject!: (value: Error) => void;
  query.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; })); p.inspect("tibble"); const old = p.observe();
  scope({ session: "session-b" }); p.sessionChanged();
  query.mockResolvedValueOnce({ ...response, target: { kind: "workspace", identity: "session-b" } }); await p.observe();
  reject(new Error("old failure")); await old; expect(p.notice).toBe(""); expect(p.details.size).toBe(0); expect(p.session).toBe("session-b");
});
it("closing and reopening views preserves cached filters and terminal invalidations", async () => {
  const { p, query } = fixture(); p.setVisible("packages:1", true); await p.observe(); p.select("stats");
  p.setVisible("packages:1", false); p.setVisible("fixture", false); p.operationChanged({ epoch: 1, project: "/project", capability: "workspace.run_r", status: "uncertain", operationId: "run", cursor: 1 });
  expect(p.data).not.toBeNull(); expect(p.dirty).toBe(true); await p.observe(); expect(query).toHaveBeenCalledTimes(1); p.setVisible("packages:2", true); await p.observe();
  expect(query).toHaveBeenCalledTimes(2); expect(p.filter).toBe("stats"); expect(p.stale).toBe(false);
});
it("stopping releases in-flight observation ownership without publishing late results", async () => {
  const { p, query, response } = fixture(); let finish!: (value: unknown) => void;
  query.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; })); const pending = p.observe();
  await Promise.resolve(); const notify = vi.fn(); p.subscribe(notify); p.stop(); finish(response); await pending; await Promise.resolve();
  expect(p.data).toBeNull(); expect(notify).not.toHaveBeenCalled();
});
it("snapshot collections and nested metadata cannot be mutated by a panel", async () => {
  const { p } = fixture(); await p.observe(); expect((p.groups as unknown as Map<string, unknown>).set).toBeUndefined();
  expect(() => { p.data!.counts.all = 99; }).toThrow(); expect(() => { p.groups.get("stats")!.name = "changed"; }).toThrow();
});
it("keeps source links inert for unsafe schemes, credentials and redacted paths", () => {
  for (const value of ["javascript:alert(1)", "data:text/html,<script>alert(1)</script>", "https://user:secret@example.org/pkg",
    "https://example.org/t/[redacted]/pkg", "https://example.org/\npath"]) expect(packageLink(value)).toBeNull();
  expect(packageLink("https://example.org/package?token=secret#private")).toBe("https://example.org/package");
});
it("inactive retained package tabs stop index pagination even when intersection reports visible", async () => {
  const { p, query, response } = fixture();
  p.viewsChanged({ activeViewIds: ["packages"] });
  query.mockResolvedValueOnce({ ...response, data: { ...response.data, groups: [response.data.groups[0]], next_offset: 1 } }); await p.observe();
  p.viewsChanged({ activeViewIds: ["objects"] }); p.setVisible("delayed-intersection", true, "packages");
  expect(p.visible).toBe(false); expect(p.needsObservation).toBe(false); await p.observe(); expect(query).toHaveBeenCalledTimes(1);
  p.viewsChanged({ activeViewIds: ["packages"] }); query.mockResolvedValueOnce({ ...response, data: { ...response.data, groups: [response.data.groups[1]], offset: 1 } });
  await p.observe(); expect(p.completeIndex).toBe(true); expect(query.mock.calls[1][2].observation_id).toBe("packages_1");
});
it("busy and unavailable package requests retain dirty work without a scheduler backlog", async () => {
  const { p, scope, query } = fixture();
  scope({ runtimeState: "busy" }); expect(p.needsObservation).toBe(false); await p.observe();
  scope({ session: null, runtimeState: null }); expect(p.needsObservation).toBe(false); await p.observe();
  expect(query).not.toHaveBeenCalled(); expect(p.dirty).toBe(true);
  scope({ session: "session-a", runtimeState: "idle" }); expect(p.needsObservation).toBe(true);
});
