import { expect, it, vi } from "vitest";
import { Studio } from "../src/studio";
import { HostClient } from "../src/host-client";
import type { PackageSnapshotData } from "../src/generated/PackageSnapshotData";
function fixture() {
  const client = new HostClient("test"),
    s = new Studio(client);
  s.info = {
    project_root: "/project",
    capabilities: [{ capability: { id: "workspace.packages" } }],
  } as typeof s.info;
  s.runtime = {
    session_id: "session-a",
    state: "idle",
    observed_at_ms: 1,
    processes: [],
    notices: [],
  };
  const data: PackageSnapshotData = {
    r_version: "4.5.2",
    r_home: "/R",
    platform: "test",
    library_paths: ["/lib"],
    mode: "installed",
    filter: "",
    offset: 0,
    next_offset: null,
    packages: [],
    scanned: 0,
    scan_complete: true,
    total_matches: 0,
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
  return {
    s,
    response,
    query: vi.spyOn(client, "query").mockResolvedValue(response as never),
  };
}
it("reads only the existing session, keeps busy observations, and retains filter across view closure", async () => {
  const { s, query } = fixture();
  s.packages.select("stats");
  await s.packages.refresh();
  expect(query).toHaveBeenCalledWith("/project", "workspace.packages", {
    expected_session: "session-a",
    filter: "stats",
    mode: "installed",
    limit: 100,
    offset: 0,
  });
  const data = s.packages.data;
  s.runtime!.state = "busy";
  await s.packages.refresh();
  expect(query).toHaveBeenCalledTimes(1);
  expect(s.packages.data).toBe(data);
  expect(s.packages.notice).toContain("R busy");
  s.packages.visible = false;
  expect(s.packages.filter).toBe("stats");
});
it("drops a late observation after runtime switch or a newer search", async () => {
  const { s, query, response } = fixture();
  let finish!: (value: never) => void;
  query.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const pending = s.packages.refresh();
  s.packages.reset();
  s.runtime!.session_id = "session-b";
  finish(response as never);
  await pending;
  expect(s.packages.data).toBeNull();
  expect(s.packages.observedAt).toBeNull();
  expect(s.packages.loading).toBe(false);
});
it("does not hide a post-run invalidation behind a pending observation", async () => {
  const { s, query, response } = fixture();
  let finish!: (value: never) => void;
  query.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const pending = s.packages.refresh();
  s.packages.invalidate();
  finish(response as never);
  await pending;
  expect(s.packages.dirty).toBe(true);
});
it("does not start or query R when no session exists", async () => {
  const { s, query } = fixture();
  s.runtime = null;
  await s.packages.refresh();
  expect(query).not.toHaveBeenCalled();
});
