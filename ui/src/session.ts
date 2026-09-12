import { Model, immutable } from "./shared/model";
import { message, sameScope } from "./shared/ports";
import type { QueryPort, RequestContext } from "./shared/ports";
import type { Notifications } from "./shared/events";
import type { WorkbenchInfo } from "./generated/WorkbenchInfo";
import type { RuntimeStatus } from "./generated/RuntimeStatus";
import type { RConfiguration } from "./generated/RConfiguration";
import type { RSelection } from "./generated/RSelection";
import type { RProbe } from "./generated/RProbe";
import type { ApplicationState } from "./generated/ApplicationState";

interface SessionPorts {
  info(): Promise<WorkbenchInfo>;
  rConfiguration(): Promise<RConfiguration>;
  selectProject(path: string): Promise<WorkbenchInfo>;
  probeR(selection: RSelection): Promise<RProbe>;
  applyR(selection: RSelection, endSession: boolean): Promise<RConfiguration>;
  quitWorkbench?(project: string): Promise<{ quitting: boolean }>;
  query: QueryPort;
  readState(project: string | null, key: string): Promise<ApplicationState>;
  writeState(project: string | null, state: ApplicationState): Promise<ApplicationState>;
  notifications: Notifications;
  transition: { before(): Promise<void>; after(projectChanged: boolean): Promise<void>; failed(): void };
}
interface SessionSnapshot {
  info: WorkbenchInfo | null; r: RConfiguration | null; runtime: RuntimeStatus | null;
  project: string | null; epoch: number; connected: boolean; error: string;
  runtimeError: string; recent: readonly string[]; switching: boolean; ready: boolean;
  workspaceInstanceId: string; nativeEpoch: number;
}

export class Session extends Model<SessionSnapshot> {
  private _info: WorkbenchInfo | null = null;
  private _r: RConfiguration | null = null;
  private selectedInstance = "main";
  private nativeRuntimes = new Map<string, RuntimeStatus>();
  private nativeExpectations = new Map<string, string | null>();
  private nativeEpochs = new Map<string, number>();
  private nativeErrors = new Map<string, string>();
  private nativeRequests = new Map<string, number>();
  private instanceViews = new Map<string, Session>();
  private _epoch = 0;
  private _connected = false;
  private _error = "";
  private _recent: string[] = [];
  private _switching = false;
  private _ready = false;
  private stopped = true;
  private healthRequest = 0;
  private configRequest = 0;
  private configurationRequest = 0;
  private configurationDirty = false;
  private hostMismatch = false;
  private mismatchMessage = "";
  constructor(private ports: SessionPorts) { super(); }
  private get _runtime() { return this.nativeRuntimes.get(this.selectedInstance) ?? null; }
  private set _runtime(value: RuntimeStatus | null) {
    if (value) this.nativeRuntimes.set(this.selectedInstance, value);
    else { this.nativeRuntimes.clear(); this.nativeExpectations.clear(); this.nativeEpochs.clear(); this.nativeErrors.clear(); this.nativeRequests.clear(); }
  }
  protected readSnapshot(): SessionSnapshot {
    return { info: this._info, r: this._r, runtime: this._runtime, project: this.project,
      epoch: this._epoch, connected: this._connected, error: this.error, runtimeError: this._runtimeError,
      recent: Object.freeze([...this._recent]), switching: this._switching, ready: this._ready,
      workspaceInstanceId: this.selectedInstance, nativeEpoch: this.nativeEpochs.get(this.selectedInstance) ?? 0 };
  }
  get info() { return this._info; }
  get r() { return this._r; }
  get runtime() { return this._runtime; }
  get project() { return this._info?.project_root ?? null; }
  get epoch() { return this._epoch; }
  get connected() { return this._connected; }
  get error() { return this.mismatchMessage || this._error; }
  get recent() { return this.getSnapshot().recent; }
  get switching() { return this._switching; }
  get ready() { return this._ready; }
  get workspaceInstanceId() { return this.selectedInstance; }
  private get _runtimeError() { return this.nativeErrors.get(this.selectedInstance) ?? ""; }
  runtimeFor(id: string) { return this.nativeRuntimes.get(id) ?? null; }
  /** View-scoped projection. Host configuration and project lifecycle still have one owner. */
  forInstance(id: string): Session {
    const existing = this.instanceViews.get(id); if (existing) return existing;
    let previous: Readonly<SessionSnapshot> | undefined, snapshot: Readonly<SessionSnapshot>;
    const getSnapshot = () => {
      const current = this.getSnapshot();
      if (current !== previous) { previous = current; snapshot = Object.freeze({ ...current, runtime: this.runtimeFor(id),
        runtimeError: this.nativeErrors.get(id) ?? "", workspaceInstanceId: id, nativeEpoch: this.nativeEpochs.get(id) ?? 0 }); }
      return snapshot;
    };
    const view = new Proxy(this, { get: (owner, property) => {
      if (property === "runtime") return owner.runtimeFor(id);
      if (property === "workspaceInstanceId") return id;
      if (property === "context") return () => owner.contextFor(id);
      if (property === "getSnapshot") return getSnapshot;
      if (property === "refreshRuntime") return () => owner.refreshRuntime(id);
      const value = Reflect.get(owner, property, owner); return typeof value === "function" ? value.bind(owner) : value;
    } });
    this.instanceViews.set(id, view); return view;
  }
  selectInstance(id: string | null) {
    const selected = id ?? "main";
    if (selected === this.selectedInstance) return;
    this.selectedInstance = selected; this.publish();
  }
  observeInstanceIdentity(id: string, native: string | null) {
    const before = this.nativeExpectations.get(id) ?? this.nativeRuntimes.get(id)?.session_id ?? null;
    this.nativeExpectations.set(id, native);
    if (before === native) return;
    this.nativeRuntimes.delete(id); this.nativeErrors.delete(id);
    this.announceNativeChange(id, native);
  }
  private announceNativeChange(id: string, native: string | null) {
    if (id === this.selectedInstance) this.configurationDirty = true;
    const nativeEpoch = (this.nativeEpochs.get(id) ?? 0) + 1;
    this.nativeEpochs.set(id, nativeEpoch);
    this.ports.notifications.send("instanceChanged", { epoch: this._epoch, project: this.project, workspaceInstanceId: id, session: native, nativeEpoch });
    this.publish();
  }
  setReady(ready: boolean) { this._ready = ready; this.publish(); }
  context = (): RequestContext => this.contextFor(this.selectedInstance);
  contextFor = (id: string): RequestContext => ({ epoch: this._epoch, project: this.project,
    workspaceInstanceId: id, nativeEpoch: this.nativeEpochs.get(id) ?? 0,
    session: this.nativeRuntimes.get(id)?.session_id ?? this.nativeExpectations.get(id) ?? null, runtimeState: this.nativeRuntimes.get(id)?.state ?? null,
    connected: this._connected, ready: this._ready, capabilities: this.hostMismatch ? [] : this._info?.capabilities.map((c) => c.capability.id) ?? [] });
  reportError(error: string) { this._error = error; this.publish(); }
  dismissError() { this.reportError(""); }
  async quitWorkbench() {
    if (!this.project || !this.ports.quitWorkbench) throw new Error("Quit is unavailable for this Workbench");
    const result = await this.ports.quitWorkbench(this.project);
    if (!result.quitting) throw new Error("Workbench shutdown was not confirmed");
    this.stopped = true; this._connected = false; this._ready = false; this.publish();
  }
  async start() {
    this.stopped = false;
    const epoch = ++this._epoch;
    let observedHost = false;
    try {
      const info = await this.ports.info();
      if (epoch !== this._epoch || this.stopped) return;
      observedHost = true;
      this._info = immutable(info); this._connected = true; this.hostMismatch = false; this.mismatchMessage = "";
      this.ports.notifications.send("projectChanged", { epoch, project: this.project });
      this.publish();
      const [r, recent] = await Promise.all([this.ports.rConfiguration(), this.ports.readState(null, "recent")]);
      if (epoch !== this._epoch || this.stopped) return;
      this._r = immutable(r);
      this.configurationDirty = false;
      this._recent = Array.isArray(recent.value) ? recent.value.filter((v): v is string => typeof v === "string") : [];
      this._error = r.error ?? "";
      this.publish();
      await this.rememberProject();
    } catch (error) {
      if (epoch === this._epoch && !this.stopped) { this._error = message(error); if (!observedHost) this._connected = false; this.publish(); }
      throw error;
    }
  }
  private async rememberProject() {
    if (this.stopped) return;
    const scope = this.context();
    if (!scope.project || this._recent[0] === scope.project) return;
    try {
      const state = await this.ports.readState(null, "recent");
      if (this.stopped || !sameScope(scope, this.context())) return;
      const recent = [scope.project, ...(Array.isArray(state.value) ? state.value.filter((v): v is string => typeof v === "string" && v !== scope.project) : [])].slice(0, 12);
      await this.ports.writeState(null, { ...state, value: recent });
      if (!this.stopped && sameScope(scope, this.context())) { this._recent = recent; this.publish(); }
    } catch (error) {
      if (!this.stopped && sameScope(scope, this.context())) this.reportError(message(error));
    }
  }
  async health() {
    const scope = this.context(), request = ++this.healthRequest;
    const current = () => request === this.healthRequest && !this.stopped && !this._switching && sameScope(scope, this.context());
    let info: WorkbenchInfo;
    try {
      info = await this.ports.info();
    } catch (error) {
      if (current()) { this._connected = false; this._error = message(error); this.publish(); }
      throw error;
    }
    if (!current()) return;
    this._connected = true;
    if (info.project_root !== this.project) {
      // The Host cannot save this window's old-project drafts after another
      // window switches it. Retain their owner and require an explicit selection.
      this.mismatchMessage = `Host is using ${info.project_root ?? "no project"}. Current project drafts are retained.`;
      if (!this.hostMismatch) {
        this.hostMismatch = true; this._epoch++; this._runtime = null;
        this.ports.notifications.send("sessionChanged", { epoch: this._epoch, project: this.project, session: null });
      }
      this.publish();
      return;
    }
    const returned = this.hostMismatch;
    const metadataChanged = JSON.stringify(info) !== JSON.stringify(this._info);
    const nativeChanged = info.runtime !== this._info?.runtime ||
      info.capabilities.some((item) => item.capability.id === "workspace.runtime_status") !==
      (this._info?.capabilities.some((item) => item.capability.id === "workspace.runtime_status") ?? false);
    this.hostMismatch = false; this.mismatchMessage = "";
    this._info = immutable(info);
    if (nativeChanged) {
      this._epoch++; this._runtime = null;
      this.ports.notifications.send("sessionChanged", { epoch: this._epoch, project: this.project, session: null });
    }
    if (returned || metadataChanged) this.configurationDirty = true;
    this.publish();
    if (this.configurationDirty) await this.refreshConfiguration(request);
  }
  private async refreshConfiguration(healthRequest?: number) {
    const scope = this.context(), request = ++this.configurationRequest;
    const current = () => request === this.configurationRequest && !this.stopped && !this._switching && !this.hostMismatch &&
      (healthRequest === undefined || healthRequest === this.healthRequest) && sameScope(scope, this.context(), true);
    try {
      const r = await this.ports.rConfiguration();
      if (!current()) return;
      this._r = immutable(r); this.configurationDirty = false; this._error = r.error ?? ""; this.publish();
    } catch (error) {
      // Configuration observation failure does not establish a Host disconnection.
      if (current()) { this._error = message(error); this.publish(); }
      throw error;
    }
  }
  async refreshRuntime(id = this.selectedInstance) {
    const scope = this.contextFor(id), request = (this.nativeRequests.get(id) ?? 0) + 1;
    this.nativeRequests.set(id, request);
    const expected = this.nativeExpectations.get(id);
    if (!scope.project || !scope.capabilities.includes("workspace.runtime_status")) return;
    const current = () => request === this.nativeRequests.get(id) && !this.stopped && sameScope(scope, this.contextFor(id)) && this.nativeExpectations.get(id) === expected;
    try {
      const result = await this.ports.query(scope.project, "workspace.runtime_status", { workspace_instance_id: id });
      if (!current()) return;
      if (result.status !== "ready" || !result.data) throw new Error(result.notices.join("\n") || `Runtime ${result.status}`);
      const runtime = result.data as RuntimeStatus;
      if (typeof runtime.session_id !== "string" || typeof runtime.state !== "string") throw new Error("Invalid runtime observation");
      if (expected !== undefined && runtime.session_id !== expected) throw new Error("The native R observation no longer matches this logical session");
      const changed = (this.nativeExpectations.get(id) ?? this.nativeRuntimes.get(id)?.session_id) !== runtime.session_id;
      if (changed) this.configurationDirty = true;
      if (changed) this.announceNativeChange(id, runtime.session_id);
      this.nativeRuntimes.set(id, immutable(runtime)); this.nativeErrors.delete(id);
      this.publish();
    } catch (error) {
      if (current()) { this.nativeErrors.set(id, message(error)); this.publish(); }
      throw error;
    }
  }
  async probeR(selection: RSelection) {
    const scope = this.context(), request = ++this.configRequest;
    const result = await this.ports.probeR(selection);
    if (this.stopped || request !== this.configRequest || !sameScope(scope, this.context())) throw new Error("R configuration changed during the check");
    return result;
  }
  async selectProject(path: string) {
    if (this._switching) throw new Error("A project or R switch is already in progress");
    this._switching = true; this.publish();
    let epoch = this._epoch;
    try {
      await this.ports.transition.before();
      if (this.stopped || epoch !== this._epoch) return;
      const info = await this.ports.selectProject(path);
      if (this.stopped || epoch !== this._epoch) return;
      epoch = ++this._epoch;
      this._info = immutable(info); this._runtime = null; this.hostMismatch = false; this.mismatchMessage = "";
      this.ports.notifications.send("projectChanged", { epoch, project: this.project });
      const r = await this.ports.rConfiguration();
      if (this.stopped || epoch !== this._epoch) return;
      this._r = immutable(r); this.configurationDirty = false; this._error = r.error ?? "";
      await this.ports.transition.after(true);
      if (this.stopped || epoch !== this._epoch) return;
      await this.rememberProject();
    } catch (error) {
      if (!this.stopped && epoch === this._epoch) { this.reportError(message(error)); this.ports.transition.failed(); }
      throw error;
    } finally {
      if (!this.stopped && epoch === this._epoch) { this._switching = false; this.publish(); }
    }
  }
  async applyR(selection: RSelection, endSession: boolean) {
    if (this._switching) throw new Error("A project or R switch is already in progress");
    if (this.hostMismatch) throw new Error(this.mismatchMessage);
    this._switching = true; this.publish();
    let epoch = this._epoch;
    try {
      await this.ports.transition.before();
      if (this.stopped || epoch !== this._epoch) return;
      const r = await this.ports.applyR(selection, endSession);
      if (this.stopped || epoch !== this._epoch) return;
      epoch = ++this._epoch; this._r = immutable(r); this.configurationDirty = false; this._runtime = null; this._error = r.error ?? "";
      const info = await this.ports.info();
      if (this.stopped || epoch !== this._epoch) return;
      this._info = immutable(info);
      this.ports.notifications.send("sessionChanged", { epoch, project: this.project, session: null });
      await this.ports.transition.after(false);
    } catch (error) {
      if (!this.stopped && epoch === this._epoch) { this.reportError(message(error)); this.ports.transition.failed(); }
      throw error;
    } finally {
      if (!this.stopped && epoch === this._epoch) { this._switching = false; this.publish(); }
    }
  }
  stop() { this.stopped = true; this._epoch++; this._switching = false; this.publish(); this.dispose(); }
}
