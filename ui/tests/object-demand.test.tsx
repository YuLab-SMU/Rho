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
afterEach(() => { cleanup(); vi.unstubAllGlobals(); state.owner?.stop(); });
const binding = (name: string) => ({ name, classes: ["data.frame"], object_type: "list", kind: "value", length: 1,
  dimensions: [1, 1], preview: [{ name: "value", values: [1] }], truncated: false, notice: null });

it("loads every explicitly expanded row even when its preview never intersects the scroll viewport", async () => {
  // A preview below the panel's clipped bottom can remain nonintersecting forever.
  vi.stubGlobal("IntersectionObserver", class { observe() {} disconnect() {} });
  const scope: ResourceIdentity = { epoch: 1, project: "/project", session: "session", runtimeState: "idle", connected: true,
    capabilities: ["workspace.snapshot", "workspace.inspect_object"] };
  const response = (data: unknown) => ({ target: { kind: "workspace", identity: "session" }, status: "ready", data, notices: [], observed_at_ms: 1 });
  const names = ["raw", "clean", "summary_by_year"];
  const query = vi.fn(async (_project, capability, args) => response(capability === "workspace.snapshot"
    ? { objects: names.map(binding), total_bindings: 3, truncated: false }
    : binding(args.name)));
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
  await act(async () => { for (const _name of names) await owner.observe(); });
  expect(container.querySelectorAll("table")).toHaveLength(3);
  expect(query.mock.calls.filter(([, capability]) => capability === "workspace.inspect_object").map(([, , args]) => args.name)).toEqual(names);
});
