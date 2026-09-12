import { Model, immutable, readonlyMap, readonlySet } from "./shared/model";
import { message, sameScope } from "./shared/ports";
import { workspaceArguments } from "./runtime-ports";
import type { RuntimeSessionsPorts, RuntimeTarget } from "./runtime-ports";
import type { RequestContext } from "./shared/ports";
import type { WorkspaceInstance } from "./generated/WorkspaceInstance";
import type { RuntimeInstances } from "./generated/RuntimeInstances";
import type { RuntimeSettings } from "./generated/RuntimeSettings";
import type { RuntimeSettingsScope } from "./generated/RuntimeSettingsScope";
import type { RuntimePolicy } from "./generated/RuntimePolicy";
import type { RuntimePolicyOverrides } from "./generated/RuntimePolicyOverrides";
import type { RuntimeEffectivePolicy } from "./generated/RuntimeEffectivePolicy";
import type { RuntimeLaunchBinding } from "./generated/RuntimeLaunchBinding";
import type { CheckpointCaptureArguments } from "./generated/CheckpointCaptureArguments";
import type { CheckpointEntry } from "./generated/CheckpointEntry";
import type { CheckpointList } from "./generated/CheckpointList";
import type { QuerySnapshot } from "./generated/QuerySnapshot";

export interface RecoveryCatalog {
  readonly entries: readonly CheckpointEntry[];
  readonly next: string | null;
  readonly observedAt: number | null;
  readonly nativeCaptureAvailable: boolean | null;
  readonly notice: string;
  readonly stale: boolean;
}
export interface RuntimeSessionsSnapshot {
  readonly instances: ReadonlyMap<string, WorkspaceInstance>;
  readonly catalogIds: readonly string[];
  readonly selectedId: string | null;
  readonly defaultId: string | null;
  readonly total: number | null;
  readonly next: string | null;
  readonly stale: boolean;
  readonly observedAt: number | null;
  readonly viewTargets: ReadonlyMap<string, string>;
  readonly recovery: ReadonlyMap<string, RecoveryCatalog>;
  readonly settings: ReadonlyMap<string, RuntimeSettings>;
  readonly loading: ReadonlySet<string>;
  readonly commands: ReadonlySet<string>;
  readonly errors: ReadonlyMap<string, string>;
  readonly dismissedRecoveryNotices: ReadonlySet<string>;
}

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const identity = (value: unknown): value is string => typeof value === "string" && !!value && value.length <= 1024 && !/[\u0000-\u001f]/.test(value);
const copy = <T>(value: T): T => immutable(structuredClone(value));
const settingsKey = (id: string | null) => id ?? "project";
const emptyRecovery = (): RecoveryCatalog => ({ entries: [], next: null, observedAt: null, nativeCaptureAvailable: null, notice: "", stale: true });

function instance(value: unknown, expected?: string): WorkspaceInstance {
  if (!object(value) || !identity(value.workspace_instance_id) || (expected !== undefined && value.workspace_instance_id !== expected) ||
    !identity(value.name) || !identity(value.continuation_lineage_id) || !object(value.binding) || !object(value.policy) ||
    !Array.isArray(value.blockers) || !(value.native_session_id === null || identity(value.native_session_id)) ||
    !["stopped", "starting", "ready", "stopping", "recovery_required", "failed"].includes(String(value.state)))
    throw new Error("R session observation identity does not match");
  if (value.state === "ready" && !identity(value.native_session_id)) throw new Error("Ready R session has no native identity");
  return value as unknown as WorkspaceInstance;
}

export function runtimePolicySource(policy: RuntimeEffectivePolicy, field: keyof RuntimePolicy): "instance" | "project" | "app" | "default" {
  for (const source of ["instance", "project", "app"] as const) {
    const value = policy[source][field as keyof RuntimePolicyOverrides];
    if (value !== null && value !== undefined) return source;
  }
  return "default";
}

/** Read models and UI target preferences only. Operations owns every durable request and outcome. */
export class RuntimeSessions extends Model<RuntimeSessionsSnapshot> {
  private instancesValue = new Map<string, WorkspaceInstance>();
  private instanceStamps = new Map<string, number>();
  private ids: string[] = [];
  private selectedValue: string | null = null;
  private defaultValue: string | null = null;
  private totalValue: number | null = null;
  private nextValue: string | null = null;
  private observedValue: number | null = null;
  private dirty = true;
  private invalidation = 0;
  private pins = new Map<string, string>();
  private recoveryValue = new Map<string, RecoveryCatalog>();
  private recoveryEpoch = 0;
  private recoveryVersions = new Map<string, number>();
  private settingsValue = new Map<string, RuntimeSettings>();
  private reads = new Map<string, Promise<void>>();
  private activeCommands = new Set<string>();
  private errorsValue = new Map<string, string>();
  private generation = 0;
  private sequence = 0;
  private selectionVersion = 0;
  private stopped = false;
  private dismissedRecoveryNotices = new Set<string>();
  constructor(private readonly ports: RuntimeSessionsPorts) { super(); }

  protected readSnapshot(): RuntimeSessionsSnapshot {
    return { instances: readonlyMap(this.instancesValue), catalogIds: Object.freeze([...this.ids]), selectedId: this.selectedValue,
      defaultId: this.defaultValue, total: this.totalValue, next: this.nextValue, stale: this.dirty, observedAt: this.observedValue,
      viewTargets: readonlyMap(this.pins), recovery: readonlyMap(this.recoveryValue), settings: readonlyMap(this.settingsValue),
      loading: readonlySet(new Set(this.reads.keys())), commands: readonlySet(this.activeCommands), errors: readonlyMap(this.errorsValue), dismissedRecoveryNotices: readonlySet(this.dismissedRecoveryNotices) };
  }
  get selectedId() { return this.selectedValue; }
  get supported() { return this.ports.context().capabilities.includes("runtime.instances"); }
  get selected() { return this.selectedValue ? this.instancesValue.get(this.selectedValue) ?? null : null; }
  get needsObservation() { return !this.stopped && this.dirty && this.ports.context().connected; }
  getInstance(id: string) { return this.instancesValue.get(id) ?? null; }
  recoveryFor(id: string) { return this.recoveryValue.get(id) ?? null; }
  settingsFor(id: string | null) { return this.settingsValue.get(settingsKey(id)) ?? null; }
  targetForView(viewId: string) { return this.pins.get(viewId) ?? this.selectedValue; }
  dismissRecoveryNotice(native: string) {
    this.dismissedRecoveryNotices = new Set([...this.dismissedRecoveryNotices, native].slice(-256));
    this.ports.changed(); this.publish();
  }

  select(id: string) {
    if (!this.instancesValue.has(id)) throw new Error("Inspect the R session before selecting it");
    if (id === this.selectedValue) return;
    this.selectedValue = id; this.selectionVersion++; this.ports.selectionChanged?.(id); this.ports.changed(); this.publish();
  }
  pinView(viewId: string, id: string | null) {
    if (!identity(viewId)) throw new Error("A view identity is required");
    if (id !== null && !this.instancesValue.has(id)) throw new Error("Inspect the R session before pinning a view");
    if (id === null) this.pins.delete(viewId); else this.pins.set(viewId, id);
    this.ports.changed(); this.publish();
  }
  restoreViewTarget(viewId: string, id: string) {
    if (!identity(viewId) || !identity(id)) throw new Error("Invalid saved R view binding");
    if (this.pins.get(viewId) === id) return;
    this.pins.set(viewId, id); this.ports.changed(); this.publish();
  }
  captureTarget(id: string | null = this.selectedValue): RuntimeTarget {
    const value = id ? this.instancesValue.get(id) : null;
    if (!value || value.state !== "ready" || !value.native_session_id) throw new Error("The selected R session is not ready");
    return Object.freeze({ workspaceInstanceId: value.workspace_instance_id, nativeSessionId: value.native_session_id,
      continuationLineageId: value.continuation_lineage_id });
  }
  serialize() {
    return { runtimeSessions: { selectedWorkspaceInstanceId: this.selectedValue, viewTargets: Object.fromEntries(this.pins), dismissedRecoveryNotices: [...this.dismissedRecoveryNotices] } };
  }
  restore(value: unknown) {
    this.reset();
    const data = object(value) && object(value.runtimeSessions) ? value.runtimeSessions : null;
    if (identity(data?.selectedWorkspaceInstanceId)) this.selectedValue = data.selectedWorkspaceInstanceId;
    if (Array.isArray(data?.dismissedRecoveryNotices)) this.dismissedRecoveryNotices = new Set(data.dismissedRecoveryNotices.filter(identity).slice(-256));
    if (object(data?.viewTargets)) for (const [view, id] of Object.entries(data.viewTargets).slice(0, 256))
      if (identity(view) && identity(id)) this.pins.set(view, id);
    this.ports.selectionChanged?.(this.selectedValue);
    this.publish();
  }
  reset() {
    this.generation++; this.selectionVersion++; this.stopped = false;
    this.instancesValue.clear(); this.instanceStamps.clear(); this.ids = []; this.selectedValue = null;
    this.defaultValue = null; this.totalValue = null; this.nextValue = null; this.observedValue = null;
    this.pins.clear(); this.dismissedRecoveryNotices.clear(); this.recoveryValue.clear(); this.recoveryVersions.clear(); this.recoveryEpoch++; this.settingsValue.clear(); this.reads.clear();
    this.activeCommands.clear(); this.errorsValue.clear(); this.dirty = true; this.invalidation++; this.publish();
    this.ports.selectionChanged?.(null);
  }
  stop() { this.stopped = true; this.generation++; this.reads.clear(); this.activeCommands.clear(); this.publish(); }
  invalidate(id?: string) {
    this.dirty = true; this.invalidation++;
    if (id === undefined) this.recoveryEpoch++;
    else this.recoveryVersions.set(id, (this.recoveryVersions.get(id) ?? 0) + 1);
    for (const [key, catalog] of this.recoveryValue) if (id === undefined || key === id)
      this.recoveryValue.set(key, copy({ ...catalog, stale: true }));
    this.ports.schedule(); this.publish();
  }
  private current(scope: RequestContext, generation: number) {
    return !this.stopped && generation === this.generation && sameScope(scope, this.ports.context());
  }
  private acceptInstance(value: WorkspaceInstance, stamp: number) {
    const id = value.workspace_instance_id;
    if (stamp < (this.instanceStamps.get(id) ?? 0)) return;
    const previous = this.instancesValue.get(id) ?? null, current = copy(value);
    this.instancesValue.set(id, current); this.instanceStamps.set(id, stamp);
    if (!previous || JSON.stringify(previous) !== JSON.stringify(current)) this.ports.instanceObserved?.(previous, current);
  }
  private read(key: string, capability: string, args: unknown, accept: (data: unknown, result: QuerySnapshot, stamp: number) => void): Promise<void> {
    const existing = this.reads.get(key);
    if (existing) return existing;
    const scope = this.ports.context(), generation = this.generation, stamp = ++this.sequence;
    if (!scope.project || !scope.connected || this.stopped) return Promise.resolve();
    const task = (async () => {
      try {
        const result = await this.ports.query(scope.project!, capability, args);
        if (!this.current(scope, generation)) return;
        if (result.status !== "ready" || !result.data) throw new Error(result.notices.join("\n") || `${capability}: ${result.status}`);
        accept(result.data, result, stamp); this.errorsValue.delete(key); this.publish();
      } catch (error) {
        if (this.current(scope, generation)) { this.errorsValue.set(key, message(error)); this.publish(); }
        throw error;
      }
    })();
    this.reads.set(key, task); this.publish();
    void task.finally(() => { if (this.reads.get(key) === task) { this.reads.delete(key); this.publish(); } }).catch(() => {});
    return task;
  }
  async initialize() {
    await this.refreshInstances();
    if (this.selectedValue && !this.instancesValue.has(this.selectedValue)) await this.refreshInstance(this.selectedValue);
  }
  async observe() { if (this.needsObservation) await this.refreshInstances(); return this.needsObservation; }
  refreshInstances(older = false) {
    if (older && this.nextValue === null) return Promise.resolve();
    const cursor = older ? this.nextValue : null, invalidation = this.invalidation;
    return this.read("instances", "runtime.instances", { after_instance_id: cursor, limit: 50 }, (data, result, stamp) => {
      const page = data as RuntimeInstances;
      if (!object(data) || !Array.isArray(page.instances) || page.instances.length > 50 || !Number.isSafeInteger(page.total) || page.total < page.instances.length ||
        !(page.default_workspace_instance_id === null || identity(page.default_workspace_instance_id)) ||
        !(page.next_after_instance_id === null || identity(page.next_after_instance_id))) throw new Error("Invalid R session catalog page");
      const values = page.instances.map((entry) => instance(entry)), ids = values.map((entry) => entry.workspace_instance_id);
      const defaultId = page.default_workspace_instance_id;
      const follows = (id: string, before: string) => id !== before && id !== defaultId && (before === defaultId || id > before);
      if (new Set(ids).size !== ids.length || (older && defaultId !== this.defaultValue) ||
        ids.some((id, index) => (index > 0 && !follows(id, ids[index - 1]!)) || (cursor !== null && !follows(id, cursor))) ||
        (page.next_after_instance_id !== null && (!ids.length || page.next_after_instance_id !== ids.at(-1))))
        throw new Error("R session catalog cursor did not advance");
      for (const value of values) this.acceptInstance(value, stamp);
      this.ids = older ? [...new Set([...this.ids, ...ids])] : ids;
      this.totalValue = page.total; this.nextValue = page.next_after_instance_id; this.defaultValue = page.default_workspace_instance_id;
      this.observedValue = result.observed_at_ms; if (this.invalidation === invalidation) this.dirty = false;
      // An unavailable saved target remains selected. Never silently run in another session.
      if (this.selectedValue === null && this.defaultValue !== null) {
        this.selectedValue = this.defaultValue; this.selectionVersion++; this.ports.selectionChanged?.(this.defaultValue); this.ports.changed();
      }
    });
  }
  refreshInstance(id: string) {
    return this.read(`instance:${id}`, "runtime.instance", { workspace_instance_id: id }, (data, _result, stamp) => this.acceptInstance(instance(data, id), stamp));
  }
  refreshCheckpoints(id: string, older = false) {
    const previous = this.recoveryValue.get(id) ?? emptyRecovery();
    if (older && previous.next === null) return Promise.resolve();
    const cursor = older ? previous.next : null, epoch = this.recoveryEpoch, version = this.recoveryVersions.get(id) ?? 0;
    return this.read(`checkpoints:${id}`, "workspace.checkpoints", workspaceArguments(id, { before: cursor, limit: 20 }), (data, result) => {
      const page = data as CheckpointList;
      if (!object(data) || !Array.isArray(page.entries) || page.entries.length > 20 || typeof page.native_capture_available !== "boolean" ||
        !(page.next === null || identity(page.next)) || (cursor !== null && page.next === cursor)) throw new Error("Invalid recovery copy page");
      const seen = new Set<string>();
      for (const entry of page.entries) {
        if (!object(entry) || !object(entry.manifest) || entry.manifest.workspace_instance_id !== id || !identity(entry.manifest.checkpoint_id) ||
          seen.has(entry.manifest.checkpoint_id) || typeof entry.available !== "boolean" || typeof entry.pinned !== "boolean")
          throw new Error("Recovery copy identity does not match its R session");
        seen.add(entry.manifest.checkpoint_id);
      }
      const entries = new Map((older ? previous.entries : []).map((entry) => [entry.manifest.checkpoint_id, entry]));
      for (const entry of page.entries) entries.set(entry.manifest.checkpoint_id, entry);
      this.recoveryValue.set(id, copy({ entries: [...entries.values()], next: page.next, nativeCaptureAvailable: page.native_capture_available,
        notice: page.notice ?? "", observedAt: result.observed_at_ms,
        stale: epoch !== this.recoveryEpoch || version !== (this.recoveryVersions.get(id) ?? 0) }));
    });
  }
  refreshSettings(id: string | null = null) {
    return this.read(`settings:${settingsKey(id)}`, "runtime.settings", { workspace_instance_id: id }, (data) => {
      if (!object(data) || !object(data.effective) || !object(data.effective.value) ||
        !["app_version", "project_version", "instance_version"].every((key) => data[key] === null || identity(data[key])))
        throw new Error("Invalid runtime settings observation");
      this.settingsValue.set(settingsKey(id), copy(data as unknown as RuntimeSettings));
    });
  }
  private async command(capability: string, args: unknown, targetId?: string, selectReady = false) {
    const key = targetId ?? capability, scope = this.ports.context(), generation = this.generation, selectedAtStart = this.selectionVersion;
    if (!scope.project || !scope.connected || this.stopped) throw new Error("Host Unavailable");
    if (this.activeCommands.has(key)) throw new Error("A command for this R session is already awaiting a result");
    this.activeCommands.add(key); this.errorsValue.delete(`command:${key}`); this.publish();
    try {
      // Do not generate request IDs here or retry an uncertain reply. Operations persists the original invocation.
      const record = await this.ports.commands.invoke(capability, args);
      if (!this.current(scope, generation)) return record;
      if (record.status === "succeeded" && capability !== "runtime.update_settings" && capability.startsWith("runtime.")) {
        const value = instance(record.output, targetId);
        this.acceptInstance(value, ++this.sequence);
        if (selectReady && value.state === "ready" && selectedAtStart === this.selectionVersion) this.select(value.workspace_instance_id);
      }
      this.invalidate(targetId);
      return record;
    } catch (error) {
      if (this.current(scope, generation)) { this.errorsValue.set(`command:${key}`, message(error)); this.invalidate(targetId); }
      throw error;
    } finally { if (this.current(scope, generation)) { this.activeCommands.delete(key); this.publish(); } }
  }
  createInstance(name: string, binding: RuntimeLaunchBinding, options: { start?: boolean; selectWhenReady?: boolean; policy?: Partial<RuntimePolicyOverrides> } = {}) {
    return this.command("runtime.create_instance", { name, binding, start: options.start ?? true, policy: options.policy ?? {} }, undefined, options.selectWhenReady ?? true);
  }
  async continueInstance(id: string, startEmpty = false) {
    const value = this.instancesValue.get(id);
    if (!value) throw new Error("Inspect the R session before continuing it");
    if (startEmpty && value.state === "recovery_required" && value.native_session_id) {
      const stopped = await this.stopInstance({ workspaceInstanceId: id, nativeSessionId: value.native_session_id, continuationLineageId: value.continuation_lineage_id }, true);
      if (stopped.status !== "succeeded") return stopped;
    }
    return this.command("runtime.continue_instance", { workspace_instance_id: id, expected_continuation_lineage_id: value.continuation_lineage_id, start_empty: startEmpty }, id);
  }
  stopInstance(target: RuntimeTarget, discardUnsavedObjects = false) {
    return this.command("runtime.stop_instance", { workspace_instance_id: target.workspaceInstanceId,
      expected_native_session_id: target.nativeSessionId, discard_unsaved_objects: discardUnsavedObjects }, target.workspaceInstanceId);
  }
  async stopForQuit(target: RuntimeTarget, discardUnsavedObjects = false) {
    if (!this.ports.stopWork) throw new Error("This Host cannot observe queue shutdown");
    await this.ports.stopWork(target.workspaceInstanceId);
    return this.stopInstance(target, discardUnsavedObjects);
  }
  restartInstance(target: RuntimeTarget, discardUnsavedObjects = false) {
    return this.command("runtime.restart_instance", { workspace_instance_id: target.workspaceInstanceId,
      expected_native_session_id: target.nativeSessionId, clean: true, discard_unsaved_objects: discardUnsavedObjects }, target.workspaceInstanceId);
  }
  renameInstance(id: string, name: string, expectedName?: string) {
    const value = this.instancesValue.get(id);
    if (!value) throw new Error("Inspect the R session before renaming it");
    return this.command("runtime.rename_instance", { workspace_instance_id: id, expected_name: expectedName ?? value.name, name }, id);
  }
  restoreInNewSession(id: string, checkpointId: string, name: string, selectWhenReady = true, binding?: RuntimeLaunchBinding) {
    return this.command("runtime.restore_instance", { source_workspace_instance_id: id, checkpoint_id: checkpointId, name, ...(binding ? { binding } : {}) }, undefined, selectWhenReady);
  }
  captureCheckpoint(target: RuntimeTarget, options: Partial<Omit<CheckpointCaptureArguments, "expected_session" | "automatic">> = {}) {
    const policy = this.getInstance(target.workspaceInstanceId)?.policy.value;
    return this.command("workspace.checkpoint_capture", workspaceArguments(target.workspaceInstanceId,
      { include_names: policy?.object_selection === "selected" ? policy.include_names : null,
        exclude_names: policy?.exclude_names ?? [], include_patterns: policy?.object_selection === "selected" ? policy.include_patterns : [], exclude_patterns: policy?.exclude_patterns ?? [],
        max_bytes: policy?.automatic_payload_limit_bytes ?? 2 * 1024 ** 3,
        max_seconds: Math.max(1, Math.ceil((policy?.capture_budget_ms ?? 2000) / 1000)),
        ...options, expected_session: target.nativeSessionId, automatic: false }), target.workspaceInstanceId);
  }
  pinCheckpoint(id: string, checkpointId: string, pinned: boolean) {
    return this.command("workspace.checkpoint_pin", workspaceArguments(id, { checkpoint_id: checkpointId, pinned }), id);
  }
  deleteCheckpoint(id: string, checkpointId: string) {
    return this.command("workspace.checkpoint_delete", workspaceArguments(id, { checkpoint_id: checkpointId }), id);
  }
  async updateSettings(scope: RuntimeSettingsScope, id: string | null, overrides: Partial<RuntimePolicyOverrides>, observedVersion?: string | null) {
    const settings = this.settingsFor(id);
    if (!settings || (scope === "instance" && id === null)) throw new Error("Read this scope’s settings before changing them");
    const context = this.ports.context(), generation = this.generation;
    const record = await this.command("runtime.update_settings", { scope, workspace_instance_id: scope === "instance" ? id : null,
      expected_version: observedVersion === undefined ? settings[`${scope}_version`] : observedVersion,
      overrides: { ...settings.effective[scope], ...overrides } }, scope === "instance" ? id! : `settings:${scope}`);
    if (record.status === "succeeded" && this.current(context, generation)) {
      try { await this.refreshSettings(id); } catch { /* A failed follow-up read cannot revoke the original write receipt. */ }
    }
    return record;
  }
}
