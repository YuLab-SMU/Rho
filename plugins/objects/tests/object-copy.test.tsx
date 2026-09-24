// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Objects } from "../src/objects";
import { VectorInspector } from "../src/views/object-vector-view";
import { ObjectsViewContext } from "../src/view-services";
import type { ObjectsViewServices } from "../src/view-services";
import type { ObjectMetadata } from "../public/r-protocol/index.js";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const metadata: ObjectMetadata = { classes: [], object_type: "double", kind: "value", length: 1,
  dimensions: [], supported_reads: ["values"], attributes: [], notice: null };
async function fixture() {
  const ready = (data: unknown) => ({ session_id: "session", source: "fixture", status: "ready", data,
    notices: [], observed_at_ms: Date.now(), completeness: "complete", diagnostic: null });
  const query = vi.fn(async (_project, capability, args) => ready(capability === "r.list_objects"
    ? { directory_ref: "directory", entries: [{ name: "x", metadata }], total: 1, offset: 0, next_offset: null, complete: true, observed_at_ms: Date.now(), notices: [] }
    : capability === "r.observe_object"
      ? { object_ref: "ref-x", name: "x", path: [], metadata, observed_at_ms: Date.now(), expires_at_ms: Date.now() + 60000 }
      : { object_ref: args.object_ref, root_name: "x", observed_path: [], path: [], kind: "values", metadata,
        values: [{ kind: "value", object_type: "double", number: 1, logical: null, imaginary: null, text: null, label: null, text_characters: null, next_text_start: null }], children: [], columns: [],
        start: 1, next_start: null, column_start: 1, next_column_start: null, text_start: 1, next_text_start: null, observed_at_ms: Date.now(), complete: true, notices: [] }));
  const owner = new Objects({ context: () => ({ epoch: 1, project: "/project", session: "session", runtimeState: "idle", connected: true,
    capabilities: ["r.list_objects", "r.observe_object", "r.read_object"] }), query: query as never, schedule: vi.fn(), changed: vi.fn() });
  await owner.observe(); owner.inspect("x"); await owner.observe(); await owner.observe();
  let produce!: () => Promise<string>, confirm!: () => void, reject!: (error: Error) => void;
  const copyText = vi.fn((source: string | (() => Promise<string>)) => {
    expect(typeof source).toBe("function"); produce = source as () => Promise<string>;
    return new Promise<void>((yes, no) => { confirm = yes; reject = no; });
  });
  const services: ObjectsViewServices = { objects: owner, session: { project: "/project", runtime: { state: "idle" } },
    navigation: { openObject: vi.fn() }, execution: { run: vi.fn() }, clipboard: { copyText } };
  render(<ObjectsViewContext.Provider value={services}><VectorInspector name="x" path={[]} viewId="objects" metadata={metadata} inline /></ObjectsViewContext.Provider>);
  return { owner, query, copyText, produce: () => produce(), confirm: () => confirm(), reject: (error: Error) => reject(error) };
}

it("reserves copying before gathering vector pages and reports success only after native confirmation", async () => {
  const f = await fixture();
  const collect = vi.spyOn(f.owner, "collectVector");
  await userEvent.click(screen.getByRole("button", { name: "Copy vector", exact: true }));
  expect(f.copyText).toHaveBeenCalledTimes(1); expect(collect).not.toHaveBeenCalled();
  let result: string | undefined;
  await act(async () => {
    const data = f.produce().then(text => result = text);
    for (let n = 0; n < 20 && result === undefined; n++) { await f.owner.observe(); await Promise.resolve(); }
    await data;
  });
  expect(collect).toHaveBeenCalledTimes(1); expect(result).toContain("1");
  expect(screen.queryByText("Copied 1 value")).toBeNull();
  await act(async () => f.confirm());
  expect(screen.getByText("Copied 1 value")).toBeTruthy(); f.owner.stop();
});

it("a changed observation before collection never becomes copied content", async () => {
  const f = await fixture();
  await userEvent.click(screen.getByRole("button", { name: "Copy vector", exact: true }));
  await act(async () => {
    f.owner.invalidate();
    try { await f.produce(); throw new Error("Unexpected content"); }
    catch (error) { expect(String(error)).toContain("observation changed"); f.reject(error as Error); }
  });
  expect(screen.queryByText("Copied 1 value")).toBeNull();
  expect(screen.getByText(/The object observation changed/)).toBeTruthy(); f.owner.stop();
});
