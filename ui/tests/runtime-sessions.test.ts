import { expect, it, vi } from "vitest";
import { RuntimeSessions, runtimePolicySource } from "../src/runtime-sessions";
import type { RequestContext } from "../src/shared/ports";
import type { WorkspaceInstance } from "../src/generated/WorkspaceInstance";
import type { RuntimePolicy } from "../src/generated/RuntimePolicy";
import type { RuntimePolicyOverrides } from "../src/generated/RuntimePolicyOverrides";
import type { QuerySnapshot } from "../src/generated/QuerySnapshot";
import type { OperationRecord } from "../src/generated/OperationRecord";
import type { CheckpointEntry } from "../src/generated/CheckpointEntry";

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const observed = (data: unknown): QuerySnapshot => ({ target: { kind: "project", identity: "/study" }, source: "host", observed_at_ms: 123,
  status: "ready", completeness: "complete", data: data as QuerySnapshot["data"], notices: [], next_reads: [], diagnostics: [] });
const policy = (): RuntimePolicy => ({ mode: "auto_continue", object_selection: "all_eligible", include_names: [], exclude_names: [], include_patterns: [], exclude_patterns: [],
  idle_delay_seconds: 30, automatic_interval_seconds: 300, automatic_payload_limit_bytes: 2 * 1024 ** 3, capture_budget_ms: 2000,
  recent_checkpoints: 5, daily_retention_days: 7, project_storage_limit_bytes: 10 * 1024 ** 3, global_storage_limit_bytes: 50 * 1024 ** 3,
  minimum_free_bytes: 2 * 1024 ** 3, max_running_instances: 4, idle_stop_without_windows_seconds: null });
const overrides = () => ({}) as RuntimePolicyOverrides;
function session(id: string, native: string | null = `r-${id}`): WorkspaceInstance {
  return { workspace_instance_id: id, name: id === "main" ? "Main" : id, binding: { r_executable: "/R", ark_executable: "/ark", environment_realization_id: "env-1", library_path: null, checkpoint_helper_path: null },
    installation: { r_home: "/R-home", r_version: "4.5.2", platform: "arm64" }, native_session_id: native, continuation_lineage_id: `lineage-${id}`,
    state: native ? "ready" : "stopped", policy: { value: policy(), app: overrides(), project: overrides(), instance: overrides() }, blockers: [], last_error: null, last_lifecycle_operation_id: null };
}
const settings = () => ({ effective: { value: policy(), app: overrides(), project: overrides(), instance: overrides() }, app_version: "app-1", project_version: "project-1", instance_version: "instance-1" });
function record(capability: string, args: unknown, output: unknown): OperationRecord {
  return { operation: { operation_id: "original-op", client_request_id: "original-request", caller: { kind: "human", id: "user" },
    capability: { id: capability, version: 1 }, domain: "workspace", target: { kind: "project", identity: "/study" }, normalized_arguments: args as never,
    invocation_digest: "digest", idempotency_scope: "/study", preconditions: [], potential_effects: [], correlation_id: "original-op",
    causation_id: null, trace_parent: null, accepted_at_ms: 1 }, status: "succeeded", outcome: null, output: output as never,
    error: null, recovery: null, cancellation_requested: false, updated_at_ms: 2 };
}
function checkpoint(id: string, owner = "main"): CheckpointEntry {
  return { pinned: false, available: true, manifest: { checkpoint_id: id, workspace_instance_id: owner,
    native_session_id: `r-${owner}`, continuation_lineage_id: `lineage-${owner}`, environment_fingerprint: "env", activity_boundary: 1,
    created_at_ms: 100, sha256: "sha", byte_size: 420, automatic: true, validation: "byte_integrity_verified",
    report: { saved_names: ["samples"], skipped: [{ name: "db", reason: "live connection" }], r_version: "4.5.2", platform: "arm64",
      library_paths: ["/lib"], package_inventory_digest: "digest", working_directory: "/study", safe_options: { digits: null, width: null, scipen: null, out_dec: null, warn: null },
      context_notices: [], required_core_namespaces: [], coverage: "partial" } } };
}
function fixture() {
  let scope: RequestContext = { project: "/study", epoch: 1, connected: true, session: "r-main", runtimeState: "idle", capabilities: [] };
  const instances = new Map([session("main"), session("scratch"), session("validation", null)].map((value) => [value.workspace_instance_id, value]));
  const query = vi.fn(async (_project: string, capability: string, args: unknown = {}) => {
    const input = args as Record<string, string>;
    if (capability === "runtime.instances") return observed({ instances: [...instances.values()], total: instances.size, default_workspace_instance_id: "main", next_after_instance_id: null });
    if (capability === "runtime.instance") return observed(instances.get(input.workspace_instance_id));
    if (capability === "runtime.settings") return observed(settings());
    if (capability === "workspace.checkpoints") return observed({ entries: [checkpoint("copy-1", input.workspace_instance_id)], next: null, native_capture_available: true, notice: null });
    throw new Error(`Unexpected query ${capability}`);
  });
  const invoke = vi.fn(async (capability: string, args: unknown) => record(capability, args, instances.get((args as { workspace_instance_id?: string }).workspace_instance_id ?? "main")));
  const ports = { context: () => ({ ...scope }), query, commands: { invoke }, changed: vi.fn(), schedule: vi.fn(), instanceObserved: vi.fn() };
  return { model: new RuntimeSessions(ports), instances, ports, setScope: (patch: Partial<RequestContext>) => { scope = { ...scope, ...patch }; } };
}

it("initialization observes sessions and the default target without starting R", async () => {
  const { model, ports } = fixture(); await model.initialize();
  expect(model.selectedId).toBe("main"); expect(model.selected?.native_session_id).toBe("r-main");
  expect(model.getSnapshot().total).toBe(3); expect(model.getSnapshot().stale).toBe(false);
  expect(ports.commands.invoke).not.toHaveBeenCalled();
  expect(ports.query).toHaveBeenCalledExactlyOnceWith("/study", "runtime.instances", { after_instance_id: null, limit: 50 });
});

it("persists only selected and pinned logical identities and never silently retargets a missing saved selection", async () => {
  const f = fixture(); f.model.restore({ runtimeSessions: { selectedWorkspaceInstanceId: "missing", viewTargets: { "console:fixed": "scratch" } } });
  await expect(f.model.initialize()).rejects.toThrow();
  expect(f.model.selectedId).toBe("missing"); expect(f.model.targetForView("console:fixed")).toBe("scratch");
  expect(() => f.model.captureTarget()).toThrow("not ready");
  expect(f.model.serialize()).toEqual({ runtimeSessions: { selectedWorkspaceInstanceId: "missing", viewTargets: { "console:fixed": "scratch" }, dismissedRecoveryNotices: [] } });
  expect(f.ports.commands.invoke).not.toHaveBeenCalled();
});

it("switching selection leaves pinned views and already captured run targets unchanged", async () => {
  const f = fixture(); await f.model.initialize(); const main = f.model.captureTarget();
  f.model.pinView("console:main", "main"); f.model.select("scratch");
  expect(f.model.targetForView("objects")).toBe("scratch"); expect(f.model.targetForView("console:main")).toBe("main");
  expect(main.nativeSessionId).toBe("r-main"); expect(f.model.captureTarget().nativeSessionId).toBe("r-scratch");
  f.model.pinView("console:main", null); expect(f.model.targetForView("console:main")).toBe("scratch");
  expect(f.ports.commands.invoke).not.toHaveBeenCalled();
});

it("loads one bounded catalog page at a time and rejects nonadvancing pages without losing current results", async () => {
  const f = fixture(); f.ports.query.mockResolvedValueOnce(observed({ instances: [session("main")], total: 3, default_workspace_instance_id: "main", next_after_instance_id: "main" }));
  await f.model.refreshInstances();
  f.ports.query.mockResolvedValueOnce(observed({ instances: [session("scratch")], total: 3, default_workspace_instance_id: "main", next_after_instance_id: "scratch" }));
  await f.model.refreshInstances(true); expect(f.model.getSnapshot().catalogIds).toEqual(["main", "scratch"]);
  f.ports.query.mockResolvedValueOnce(observed({ instances: [session("scratch")], total: 3, default_workspace_instance_id: "main", next_after_instance_id: "scratch" }));
  await expect(f.model.refreshInstances(true)).rejects.toThrow("cursor");
  expect(f.model.getSnapshot().catalogIds).toEqual(["main", "scratch"]); expect(f.model.getSnapshot().next).toBe("scratch");
});

it("late catalog reads cannot roll back a newer native session observation", async () => {
  const f = fixture(); await f.model.initialize(); const held = deferred<QuerySnapshot>();
  f.ports.query.mockImplementationOnce(() => held.promise); const reading = f.model.refreshInstances();
  f.instances.set("main", session("main", "r-main-new")); await f.model.refreshInstance("main");
  held.resolve(observed({ instances: [session("main")], total: 1, default_workspace_instance_id: "main", next_after_instance_id: null })); await reading;
  expect(f.model.selected?.native_session_id).toBe("r-main-new");
});

it("accepts created identifiers after Main across pages and refuses a repeated default", async () => {
  const f = fixture();
  f.ports.query.mockResolvedValueOnce(observed({ instances: [session("main")], total: 3, default_workspace_instance_id: "main", next_after_instance_id: "main" }));
  await f.model.refreshInstances();
  f.ports.query.mockResolvedValueOnce(observed({ instances: [session("instance_op_a")], total: 3, default_workspace_instance_id: "main", next_after_instance_id: "instance_op_a" }));
  await f.model.refreshInstances(true);
  expect(f.model.getSnapshot().catalogIds).toEqual(["main", "instance_op_a"]);
  f.ports.query.mockResolvedValueOnce(observed({ instances: [session("main")], total: 3, default_workspace_instance_id: "main", next_after_instance_id: null }));
  await expect(f.model.refreshInstances(true)).rejects.toThrow("cursor");
  f.ports.query.mockResolvedValueOnce(observed({ instances: [session("instance_op_b")], total: 3, default_workspace_instance_id: "main", next_after_instance_id: null }));
  await f.model.refreshInstances(true);
  expect(f.model.getSnapshot().catalogIds).toEqual(["main", "instance_op_a", "instance_op_b"]);
});

it("project changes and reset fence catalog and recovery replies", async () => {
  const f = fixture(), held = deferred<QuerySnapshot>(); f.ports.query.mockImplementationOnce(() => held.promise);
  const reading = f.model.refreshInstances(); f.setScope({ project: "/other", epoch: 2 }); f.model.reset();
  held.resolve(observed({ instances: [session("main")], total: 1, default_workspace_instance_id: "main", next_after_instance_id: null })); await reading;
  expect(f.model.getSnapshot().instances.size).toBe(0); expect(f.model.selectedId).toBeNull();
  expect(f.model.getSnapshot().loading.size).toBe(0);
});

it("invalidation arriving during an observation is preserved for the shared coordinator", async () => {
  const f = fixture(), held = deferred<QuerySnapshot>(); f.ports.query.mockImplementationOnce(() => held.promise);
  const reading = f.model.observe(); f.model.invalidate("main");
  held.resolve(observed({ instances: [session("main")], total: 1, default_workspace_instance_id: "main", next_after_instance_id: null }));
  expect(await reading).toBe(true); expect(f.ports.schedule).toHaveBeenCalledOnce();
});

it("recovery catalog preserves known partial coverage and requires the exact instance on every page", async () => {
  const f = fixture(); await f.model.refreshCheckpoints("validation");
  expect(f.ports.query).toHaveBeenCalledWith("/study", "workspace.checkpoints", { workspace_instance_id: "validation", before: null, limit: 20 });
  expect(f.model.recoveryFor("validation")?.entries[0].manifest.report.skipped[0].name).toBe("db");
  f.ports.query.mockResolvedValueOnce(observed({ entries: [checkpoint("wrong", "main")], next: null, native_capture_available: true, notice: null }));
  await expect(f.model.refreshCheckpoints("validation")).rejects.toThrow("identity");
  expect(f.model.recoveryFor("validation")?.entries[0].manifest.checkpoint_id).toBe("copy-1");
  expect(f.ports.commands.invoke).not.toHaveBeenCalled();
});

it("a capture completed during a catalog read keeps the displayed recovery copy explicitly stale", async () => {
  const f = fixture(), held = deferred<QuerySnapshot>(); f.ports.query.mockImplementationOnce(() => held.promise);
  const reading = f.model.refreshCheckpoints("main"); f.model.invalidate("main");
  held.resolve(observed({ entries: [checkpoint("old-copy")], next: null, native_capture_available: true, notice: null })); await reading;
  expect(f.model.recoveryFor("main")?.stale).toBe(true);
  expect(f.model.recoveryFor("main")?.entries[0].manifest.checkpoint_id).toBe("old-copy");
});

it("mutating a snapshot cannot change another session’s recovery state", async () => {
  const f = fixture(); await f.model.initialize(); await f.model.refreshCheckpoints("main");
  expect(() => { f.model.getSnapshot().instances.get("main")!.name = "changed"; }).toThrow();
  expect(() => { f.model.recoveryFor("main")!.entries[0].manifest.report.saved_names.push("bad"); }).toThrow();
  expect((f.model.getSnapshot().instances as unknown as Map<string, WorkspaceInstance>).set).toBeUndefined();
});

it("restart uses the reviewed native identity and always creates empty memory", async () => {
  const f = fixture(); await f.model.initialize(); const target = f.model.captureTarget();
  f.model.select("scratch"); const result = await f.model.restartInstance(target);
  expect(f.ports.commands.invoke).toHaveBeenCalledExactlyOnceWith("runtime.restart_instance", { workspace_instance_id: "main", expected_native_session_id: "r-main", clean: true, discard_unsaved_objects: false });
  expect(result.operation.client_request_id).toBe("original-request"); expect(f.model.selectedId).toBe("scratch");
});

it("all-supported manual capture ignores dormant include filters while exclusions still apply", async () => {
  const f = fixture();
  Object.assign(f.instances.get("main")!.policy.value, { object_selection: "all_eligible", include_names: ["old_selection"], include_patterns: ["old_*"], exclude_names: ["db"] });
  await f.model.initialize(); await f.model.captureCheckpoint(f.model.captureTarget());
  expect(f.ports.commands.invoke).toHaveBeenCalledWith("workspace.checkpoint_capture", expect.objectContaining({ include_names: null, include_patterns: [], exclude_names: ["db"] }));
});

it("a lifecycle error is never retried and overlapping commands for the same instance are rejected", async () => {
  const f = fixture(); await f.model.initialize(); const held = deferred<OperationRecord>(); f.ports.commands.invoke.mockImplementationOnce(() => held.promise);
  const stopping = f.model.stopInstance(f.model.captureTarget());
  await expect(f.model.restartInstance(f.model.captureTarget())).rejects.toThrow("awaiting a result");
  held.reject(new Error("Acknowledgement lost")); await expect(stopping).rejects.toThrow("Acknowledgement lost");
  expect(f.ports.commands.invoke).toHaveBeenCalledOnce(); expect(f.model.getSnapshot().commands.size).toBe(0);
  expect(f.model.getSnapshot().errors.get("command:main")).toBe("Acknowledgement lost");
});

it("creation adopts a ready result but cannot overwrite a later user target choice", async () => {
  const f = fixture(); await f.model.initialize(); const held = deferred<OperationRecord>(); f.ports.commands.invoke.mockImplementationOnce(() => held.promise);
  const creating = f.model.createInstance("New", session("main").binding); f.model.select("scratch");
  held.resolve(record("runtime.create_instance", {}, session("new"))); await creating;
  expect(f.model.getInstance("new")?.state).toBe("ready"); expect(f.model.selectedId).toBe("scratch");
  f.ports.commands.invoke.mockResolvedValueOnce(record("runtime.create_instance", {}, session("newer")));
  await f.model.createInstance("Newer", session("main").binding); expect(f.model.selectedId).toBe("newer");
});

it("failed creation preserves the prior target and authoritative operation result", async () => {
  const f = fixture(); await f.model.initialize(); const failed = { ...record("runtime.create_instance", {}, null), status: "failed" as const, error: "R installation missing" };
  f.ports.commands.invoke.mockResolvedValueOnce(failed);
  expect(await f.model.createInstance("New", session("main").binding)).toBe(failed); expect(f.model.selectedId).toBe("main");
});

it("explicit capture applies include/exclude policy and returns the Operation owner’s receipt", async () => {
  const f = fixture(); const main = f.instances.get("main")!; Object.assign(main.policy.value, { object_selection: "selected", include_names: ["samples"], exclude_names: ["token"], exclude_patterns: ["private_*"] });
  await f.model.initialize(); const response = await f.model.captureCheckpoint(f.model.captureTarget(), { max_bytes: 1024 });
  expect(f.ports.commands.invoke).toHaveBeenCalledWith("workspace.checkpoint_capture", expect.objectContaining({ workspace_instance_id: "main", expected_session: "r-main", automatic: false,
    include_names: ["samples"], exclude_names: ["token"], exclude_patterns: ["private_*"], max_bytes: 1024, max_seconds: 2 }));
  expect(response.operation.operation_id).toBe("original-op");
});

it("settings changes use the observed version and preserve null resets and empty lists", async () => {
  const f = fixture(); await expect(f.model.updateSettings("instance", "main", {})).rejects.toThrow("Read");
  const initial = settings(); Object.assign(initial.effective.instance, { idle_delay_seconds: 45 });
  f.ports.query.mockResolvedValueOnce(observed(initial)); await f.model.refreshSettings("main");
  const patch = { automatic_interval_seconds: null, include_names: [] };
  await f.model.updateSettings("instance", "main", patch);
  expect(f.ports.commands.invoke).toHaveBeenCalledWith("runtime.update_settings", { scope: "instance", workspace_instance_id: "main", expected_version: "instance-1", overrides: { idle_delay_seconds: 45, ...patch } });
  expect(f.ports.commands.invoke).toHaveBeenCalledOnce();
});

it("a settings read failure after a successful change preserves its original success receipt", async () => {
  const f = fixture(); await f.model.refreshSettings("main");
  f.ports.query.mockRejectedValueOnce(new Error("Read offline"));
  const response = await f.model.updateSettings("instance", "main", { mode: "manual" });
  expect(response.status).toBe("succeeded"); expect(response.operation.operation_id).toBe("original-op");
  expect(f.model.getSnapshot().errors.get("settings:main")).toBe("Read offline");
  expect(f.ports.commands.invoke).toHaveBeenCalledOnce();
});

it("settings source treats zero and empty arrays as explicit overrides", () => {
  const value = settings().effective; Object.assign(value.app, { automatic_interval_seconds: 300 });
  Object.assign(value.project, { idle_stop_without_windows_seconds: 0 }); Object.assign(value.instance, { include_names: [] });
  expect(runtimePolicySource(value, "automatic_interval_seconds")).toBe("app");
  expect(runtimePolicySource(value, "idle_stop_without_windows_seconds")).toBe("project");
  expect(runtimePolicySource(value, "include_names")).toBe("instance"); expect(runtimePolicySource(value, "mode")).toBe("default");
});
