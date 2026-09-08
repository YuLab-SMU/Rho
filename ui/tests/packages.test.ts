import { expect, it, vi } from "vitest";
import { Studio } from "../src/studio";
import { HostClient } from "../src/host-client";
import { packageLink } from "../src/packages";
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
  return {
    s,
    response,
    query: vi.spyOn(client, "query").mockResolvedValue(response as never),
  };
}
it("filters a pinned observation while busy without making another native request", async () => {
  const { s, query } = fixture();
  s.packages.select("stats");
  await s.packages.refresh();
  expect(query).toHaveBeenCalledWith("/project", "workspace.packages", {
    expected_session: "session-a",
    filter: "",
    mode: "installed",
    grouped: true,
    observation_id: null,
    package_name: null,
    limit: 200,
    offset: 0,
  });
  const data = s.packages.data;
  s.runtime!.state = "busy";
  s.packages.select("Purpose of tibble");
  await s.packages.refresh();
  expect(query).toHaveBeenCalledTimes(1);
  expect(s.packages.data).toBe(data);
  expect(s.packages.filtered.map((g) => g.name)).toEqual(["tibble"]);
  s.packages.select("", "multiple");
  expect(s.packages.filtered.map((g) => g.name)).toEqual(["tibble"]);
  s.packages.select("", "attached");
  expect(s.packages.filtered.map((g) => g.name)).toEqual(["stats"]);
  s.packages.visible = false;
  expect(s.packages.observedAt).toBe(123);
});
it("drops a late observation after runtime switch", async () => {
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
it("uses the same observation for subsequent pages and preserves a newer filter", async () => {
  const { s, query, response } = fixture();
  s.packages.visible = true;
  query.mockResolvedValueOnce({
    ...response,
    data: {
      ...response.data,
      groups: [response.data.groups[0]],
      next_offset: 1,
    },
  } as never);
  query.mockImplementationOnce(async (_p, _id, args) => {
    expect(args).toMatchObject({ observation_id: "packages_1", offset: 1 });
    s.packages.select("tibble");
    return {
      ...response,
      data: { ...response.data, groups: [response.data.groups[1]], offset: 1 },
    } as never;
  });
  await s.packages.refresh();
  expect(s.packages.completeIndex).toBe(true);
  expect(s.packages.filtered.map((g) => g.name)).toEqual(["tibble"]);
  expect(s.packages.observedAt).toBe(123);
});
it("does not describe a failed partial index as complete", async () => {
  const { s, query, response } = fixture();
  s.packages.visible = true;
  query
    .mockResolvedValueOnce({
      ...response,
      data: {
        ...response.data,
        groups: [response.data.groups[0]],
        next_offset: 1,
      },
    } as never)
    .mockRejectedValueOnce(new Error("Package observation expired"));
  await s.packages.refresh();
  expect(s.packages.groups.size).toBe(1);
  expect(s.packages.completeIndex).toBe(false);
  expect(s.packages.notice).toContain("expired");
});
it("keeps global counts distinct from search matches and loaded pages", async () => {
  const { s } = fixture();
  await s.packages.refresh();
  s.packages.select("not-present");
  expect(s.packages.filtered).toHaveLength(0);
  expect(s.packages.data!.counts.all).toBe(2);
  expect(s.packages.data!.counts.installations).toBe(3);
});
it("uses exact package identity and the observation id for copy inspection", async () => {
  const { s, query, response } = fixture();
  await s.packages.refresh();
  query.mockResolvedValueOnce({
    ...response,
    data: {
      ...response.data,
      groups: [],
      packages: [],
      package_name: "tibble",
      total_matches: 0,
    },
  } as never);
  await s.packages.inspect("tibble");
  expect(query).toHaveBeenLastCalledWith(
    "/project",
    "workspace.packages",
    expect.objectContaining({
      package_name: "tibble",
      observation_id: "packages_1",
      offset: 0,
      limit: 20,
    }),
  );
  expect(s.packages.details.get("tibble")?.notice).toBe("");
});
it("keeps source links inert for unsafe schemes, credentials and redacted paths", () => {
  for (const value of [
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "https://user:secret@example.org/pkg",
    "https://example.org/t/[redacted]/pkg",
    "https://example.org/\npath",
  ])
    expect(packageLink(value)).toBeNull();
  expect(packageLink("https://example.org/package?token=secret#private")).toBe(
    "https://example.org/package",
  );
});
