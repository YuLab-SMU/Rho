import { useSyncExternalStore } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RuntimeSessions } from "../src/runtime-sessions";
import { SessionTargetPicker } from "../src/panels/session-target";
import type { WorkspaceInstance } from "../src/generated/WorkspaceInstance";

const { state } = vi.hoisted(() => ({ state: { owner: null as RuntimeSessions | null, errors: [] as string[] } }));
vi.mock("../src/context", () => ({
  useRuntimeSessions: () => {
    const owner = state.owner!;
    useSyncExternalStore(owner.subscribe, owner.getSnapshot);
    return owner;
  },
  useSession: () => ({ reportError: (text: string) => void state.errors.push(text) }),
}));
afterEach(() => { cleanup(); state.owner?.stop(); state.owner = null; state.errors = []; vi.restoreAllMocks(); });

const observed = (data: unknown) => ({ target: { kind: "project", identity: "/study" }, source: "host", observed_at_ms: 1, status: "ready",
  completeness: "complete", data, notices: [], next_reads: [], diagnostics: [] });
function session(id: string, name: string, native: string | null): WorkspaceInstance {
  return { workspace_instance_id: id, name, binding: { r_executable: "/R", ark_executable: "/ark", environment_realization_id: "env-1", library_path: null, checkpoint_helper_path: null },
    installation: { r_home: "/R-home", r_version: "4.5.2", platform: "arm64" }, native_session_id: native, continuation_lineage_id: `lineage-${id}`,
    state: native ? "ready" : "stopped", policy: { value: {}, app: {}, project: {}, instance: {} }, blockers: [], last_error: null, last_lifecycle_operation_id: null,
    protection: { latest_checkpoint_id: null, saved_at_ms: null, saved_objects: null, skipped_objects: null, activity_since_copy: false, capture_available: false, automatic_pending: false, last_error: null } };
}
async function fixture(sessions: WorkspaceInstance[]) {
  const instances = new Map(sessions.map((value) => [value.workspace_instance_id, value]));
  const query = vi.fn(async () => observed({ instances: [...instances.values()], total: instances.size,
    default_workspace_instance_id: sessions[0]?.workspace_instance_id ?? null, next_after_instance_id: null }));
  const invoke = vi.fn(async (_capability: string, args: unknown) => ({ status: "succeeded",
    output: instances.get((args as { workspace_instance_id: string }).workspace_instance_id) }));
  const model = new RuntimeSessions({ context: () => ({ project: "/study", epoch: 1, connected: true, session: "r-main", runtimeState: "idle", capabilities: ["runtime.instances"] }),
    query: query as never, commands: { invoke: invoke as never }, changed: vi.fn(), schedule: vi.fn() });
  state.owner = model;
  await model.initialize();
  return { model, query, invoke };
}
// Radix menus need pointer-capture and scroll APIs jsdom does not implement.
function stubMenuApis() {
  for (const name of ["hasPointerCapture", "setPointerCapture", "releasePointerCapture", "scrollIntoView"]) {
    if (!Element.prototype[name as keyof Element]) Object.defineProperty(Element.prototype, name, { value: () => {}, configurable: true, writable: true });
  }
}

it("stays out of the toolbar while the project has a single R session", async () => {
  await fixture([session("main", "Main", "r-main")]);
  const { container } = render(<SessionTargetPicker />);
  expect(container.firstChild).toBeNull();
});

it("names the execution target and continues a stopped session chosen from it", async () => {
  stubMenuApis();
  const { model, invoke } = await fixture([session("main", "Main", "r-main"), session("scratch", "Scratch", "r-scratch"), session("validation", "Validation", null)]);
  render(<SessionTargetPicker />);
  await userEvent.click(screen.getByTitle("Runs go to Main"));
  // Every session is listed with the state that decides whether it can accept work.
  expect(screen.getAllByText("R 4.5.2 · Managed environment")).toHaveLength(3);
  expect(screen.getAllByText("Ready")).toHaveLength(2);
  expect(screen.getByText("Stopped")).toBeTruthy();
  await userEvent.click(screen.getByText("Validation"));
  expect(model.selectedId).toBe("validation");
  // Choosing a stopped session continues it, so the next Run has a live target.
  expect(invoke).toHaveBeenCalledExactlyOnceWith("runtime.continue_instance",
    { workspace_instance_id: "validation", expected_continuation_lineage_id: "lineage-validation", start_empty: false });
  expect(state.errors).toEqual([]);
});
