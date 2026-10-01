// @vitest-environment jsdom
import { useSyncExternalStore } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Objects } from "../src/objects";
import { ObjectsPanel, ObjectInspector } from "../src/views/object-panel";
import type { ResourceIdentity } from "../src/resource-ports";

const { state } = vi.hoisted(() => ({ state: { owner: null as Objects | null, agent: undefined as {recovering:boolean;ask:()=>void}|undefined } }));
vi.mock("../src/view-services", () => ({
  useObjects: () => {
    const owner = state.owner!;
    useSyncExternalStore(owner.subscribe, owner.getSnapshot);
    return owner;
  },
  useSession: () => ({ runtime: { state: "idle" } }),
  useNavigation: () => ({ openObject: vi.fn() }),
  useAgent: () => state.agent,
  useClipboard: () => ({ copyText: vi.fn() }),
  useExecution: () => ({ run: vi.fn() }),
}));
afterEach(() => { cleanup(); state.agent=undefined; vi.unstubAllGlobals(); vi.restoreAllMocks(); state.owner?.stop(); });
const metadata = { classes: ["data.frame"], object_type: "list", kind: "value", length: 1, dimensions: [1, 1], supported_reads: ["structure", "table", "children"], attributes: [], notice: null };

it("loads every explicitly expanded row even when its preview never intersects the scroll viewport", async () => {
  // A preview below the panel's clipped bottom can remain nonintersecting forever.
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} unobserve() {} });
  vi.stubGlobal("IntersectionObserver", class { observe() {} disconnect() {} });
  vi.spyOn(Date, "now").mockReturnValue(1);
  const scope: ResourceIdentity = { epoch: 1, project: "/project", session: "session", runtimeState: "idle", connected: true,
    capabilities: ["r.list_objects", "r.observe_object", "r.read_object"] };
  const response = (data: unknown) => ({ session_id: "session", source: "native-fixture", status: "ready", data, notices: [], observed_at_ms: 1, completeness: "complete", diagnostic: null });
  const names = ["raw", "clean", "summary_by_year"];
  const query = vi.fn(async (_project, capability, args) => response(capability === "r.list_objects"
    ? { directory_ref: "directory", entries: names.map((name) => ({ name, metadata })), total: 3, offset: 0, next_offset: null, complete: true, observed_at_ms: 1, notices: [] }
    : capability === "r.observe_object"
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
  expect(container.querySelectorAll('[role="grid"]')).toHaveLength(3);
  expect(query.mock.calls.filter(([, capability]) => capability === "r.observe_object").map(([, , args]) => args.name)).toEqual(names);
  expect(query.mock.calls.filter(([, capability]) => capability === "r.read_object").map(([, , args]) => args.object_ref)).toEqual(names.map((name) => `ref-${name}`));
});

it("allows original Agent request recovery when the R observation is unavailable", async () => {
  const query=vi.fn(),ask=vi.fn();
  const owner=new Objects({context:()=>({epoch:1,project:"/project",session:null,runtimeState:null,connected:false,capabilities:[]}),query,schedule:vi.fn(),changed:vi.fn()});
  state.owner=owner;state.agent={recovering:false,ask};
  const view=render(<ObjectInspector name="original" viewId="objects" />);
  expect((screen.getByRole("button",{name:"Ask about…"}) as HTMLButtonElement).disabled).toBe(true);
  state.agent.recovering=true;view.rerender(<ObjectInspector name="original" viewId="objects" />);
  await userEvent.click(screen.getByRole("button",{name:"Ask about…"}));
  expect(ask).toHaveBeenCalledWith("original",[]);expect(query).not.toHaveBeenCalled();
});
