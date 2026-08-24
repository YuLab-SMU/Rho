import { describe, expect, it } from "vitest";

import {
  loadProjectHistory,
  MAX_PROJECT_HISTORY,
  PROJECT_HISTORY_KEY,
  rememberProjectPath,
  saveProjectHistory,
} from "./project-history";

describe("project history", () => {
  it("starts empty and round-trips Unicode and spaced paths", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
    };
    const initial = loadProjectHistory(storage);
    expect(initial).toMatchObject({ status: "default", history: { paths: [] } });
    const history = rememberProjectPath(initial.history, "/Users/example/Rho release 空格项目");
    saveProjectHistory(storage, history);
    expect(loadProjectHistory(storage)).toMatchObject({ status: "clean", history });
  });

  it("deduplicates by exact path, moves the current path first, and stays bounded", () => {
    let history = { version: 1 as const, paths: [] as readonly string[] };
    for (let index = 0; index < MAX_PROJECT_HISTORY + 3; index += 1) {
      history = rememberProjectPath(history, `/projects/project-${index}`);
    }
    expect(history.paths).toHaveLength(MAX_PROJECT_HISTORY);
    expect(history.paths[0]).toBe(`/projects/project-${MAX_PROJECT_HISTORY + 2}`);
    const selected = history.paths[3]!;
    const reordered = rememberProjectPath(history, selected);
    expect(reordered.paths[0]).toBe(selected);
    expect(new Set(reordered.paths).size).toBe(reordered.paths.length);
  });

  it("rejects malformed, unsupported, duplicate, invalid, and oversized payloads", () => {
    const cases = [
      "{broken",
      JSON.stringify({ version: 2, paths: [] }),
      JSON.stringify({ version: 1, paths: ["/a", "/a"] }),
      JSON.stringify({ version: 1, paths: ["/valid", "bad\npath"] }),
      "x".repeat(32_769),
    ];
    for (const encoded of cases) {
      const loaded = loadProjectHistory({ getItem: () => encoded });
      expect(loaded.status).toBe("recovered");
      expect(loaded.history.paths).toEqual([]);
    }
  });

  it("keeps read and write failures explicit", () => {
    expect(loadProjectHistory({ getItem: () => { throw new Error("read denied"); } }))
      .toMatchObject({ status: "unavailable", history: { paths: [] } });
    expect(() => saveProjectHistory({
      setItem: () => { throw new Error("write denied"); },
    }, { version: 1, paths: ["/project"] })).toThrow("write denied");
  });

  it("uses one stable global device-local key", () => {
    const writes: Array<[string, string]> = [];
    saveProjectHistory({ setItem: (key, value) => { writes.push([key, value]); } }, {
      version: 1,
      paths: ["/project-a", "/project-b"],
    });
    expect(writes[0]?.[0]).toBe(PROJECT_HISTORY_KEY);
  });
});
