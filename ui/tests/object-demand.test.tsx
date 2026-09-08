import { useSyncExternalStore } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Objects } from "../src/objects";
import { ObjectsPanel } from "../src/panels/resource-panels";
import type { ResourceIdentity } from "../src/resource-ports";

const { state } = vi.hoisted(() => ({ state: { owner: null as Objects | null } }));
vi.mock("../src/context", () => ({
  useObjects: () => {
    const owner = state.owner!;
    useSyncExternalStore(owner.subscribe, owner.getSnapshot);
    return owner;
  },
  useSession: () => ({ runtime: { state: "idle" } }),
  useNavigation: () => ({ openObject: vi.fn() }),
}));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); state.owner?.stop(); });
const metadata = { classes: ["data.frame"], object_type: "list", kind: "value", length: 1, dimensions: [1, 1], supported_reads: ["structure", "table", "children"], attributes: [], notice: null };

it("loads every explicitly expanded row even when its preview never intersects the scroll viewport", async () => {
  // A preview below the panel's clipped bottom can remain nonintersecting forever.
  vi.stubGlobal("IntersectionObserver", class { observe() {} disconnect() {} });
  vi.spyOn(Date, "now").mockReturnValue(1);
  const scope: ResourceIdentity = { epoch: 1, project: "/project", session: "session", runtimeState: "idle", connected: true,
    capabilities: ["workspace.list_objects", "workspace.observe_object", "workspace.read_object"] };
  const response = (data: unknown) => ({ target: { kind: "workspace", identity: "session" }, status: "ready", data, notices: [], observed_at_ms: 1 });
  const names = ["raw", "clean", "summary_by_year"];
  const query = vi.fn(async (_project, capability, args) => response(capability === "workspace.list_objects"
    ? { directory_ref: "directory", entries: names.map((name) => ({ name, metadata })), total: 3, offset: 0, next_offset: null, complete: true, observed_at_ms: 1, notices: [] }
    : capability === "workspace.observe_object"
      ? { object_ref: `ref-${args.name}`, name: args.name, path: [], metadata, observed_at_ms: 1, expires_at_ms: 60001 }
      : { object_ref: args.object_ref, root_name: args.object_ref.slice(4), observed_path: [], path: [], kind: "table", metadata, values: [], children: [],
        columns: [{ index: 1, name: "value", metadata: { ...metadata, object_type: "double", classes: [], dimensions: [], supported_reads: ["values"] }, values: [{ kind: "value", object_type: "double", number: 1, logical: null, imaginary: null, text: null, label: null, text_characters: null, next_text_start: null }] }],
        start: 1, next_start: null, column_start: 1, next_column_start: null, text_start: 1, next_text_start: null, observed_at_ms: 1, complete: true, notices: [] }));
  const owner = new Objects({ context: () => scope, query: query as never, schedule: vi.fn(), changed: vi.fn() });
  state.owner = owner;
  owner.viewsChanged({ activeViewIds: ["objects"] });
  await owner.observe();
  const { container } = render(<ObjectsPanel />);
  for (const name of names) await userEvent.click(screen.getByRole("button", { name: new RegExp(`›\\s*${name}$`) }));
  // Switching away keeps mounted previews and their intent, but admits no hidden reads.
  owner.viewsChanged({ activeViewIds: ["console"] });
  await owner.observe(); expect(query).toHaveBeenCalledTimes(1);
  owner.viewsChanged({ activeViewIds: ["objects"] });
  await act(async () => { for (let i = 0; i < names.length * 2; i++) await owner.observe(); });
  expect(container.querySelectorAll("table")).toHaveLength(3);
  expect(query.mock.calls.filter(([, capability]) => capability === "workspace.observe_object").map(([, , args]) => args.name)).toEqual(names);
  expect(query.mock.calls.filter(([, capability]) => capability === "workspace.read_object").map(([, , args]) => args.object_ref)).toEqual(names.map((name) => `ref-${name}`));
});
