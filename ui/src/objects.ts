import { Model, immutable, readonlyMap, readonlySet } from "./shared/model";
import { sameScope, terminal, message } from "./shared/ports";
import type { OperationChange, DomainEvents } from "./shared/events";
import type { ResourcePorts } from "./resource-ports";
import type { ApplicationObjectSelection } from "./generated/ApplicationObjectSelection";
import type { BindingSummary } from "./generated/BindingSummary";
import type { WorkspaceSnapshotData } from "./generated/WorkspaceSnapshotData";

export interface ObjectObservation {
  readonly binding: BindingSummary;
  readonly observedAt: number;
  readonly notice: string;
  readonly stale: boolean;
}
interface ObjectsSnapshot {
  readonly data: WorkspaceSnapshotData | null;
  readonly observedAt: number | null;
  readonly notice: string;
  readonly stale: boolean;
  readonly loading: boolean;
  readonly expanded: ReadonlySet<string>;
  readonly inspectors: ReadonlyMap<string, ObjectObservation>;
  readonly selected: string | null;
}
/** One observation cache with independent view demands, never one request per view. */
export class Objects extends Model<ObjectsSnapshot> {
  private dataValue: WorkspaceSnapshotData | null = null;
  private time: number | null = null;
  private error = "";
  private staleValue = true;
  private expandedNames = new Set<string>();
  private previews = new Map<string, ObjectObservation>();
  private demands = new Map<string, { name: string; viewId: string }>();
  private activeViewIds: ReadonlySet<string> | null = null;
  private manual = new Set<string>();
  private names: readonly string[] = Object.freeze([]);
  private selectedName: string | null = null;
  private applicationReference: ApplicationObjectSelection | null = null;
  private pending = new Set<string>();
  private listDirty = true;
  private inFlight: { revision: number; generation: number } | null = null;
  private revision = 0;
  private generation = 0;
  private invalidation = 0;
  private stopped = false;
  constructor(private readonly ports: ResourcePorts) { super(); }
  protected readSnapshot(): ObjectsSnapshot {
    return { data: this.dataValue, observedAt: this.time, notice: this.error, stale: this.staleValue,
      loading: !!this.inFlight, expanded: readonlySet(this.expandedNames), inspectors: readonlyMap(this.previews), selected: this.selectedName };
  }
  get data() { return this.dataValue; }
  get observedAt() { return this.time; }
  get notice() { return this.error; }
  get stale() { return this.staleValue; }
  get loading() { return !!this.inFlight; }
  get expanded() { return this.getSnapshot().expanded; }
  get inspectors() { return this.getSnapshot().inspectors; }
  get selected() { return this.selectedName; }
  get applicationSelection(): ApplicationObjectSelection | null {
    const reference = this.applicationReference;
    return reference && reference.name === this.selectedName && reference.native_session_id === this.ports.context().session ? reference : null;
  }
  selectObservation(selection: ApplicationObjectSelection) {
    if (!selection.object_ref || selection.native_session_id !== this.ports.context().session) throw new Error("The selected object observation is no longer current.");
    this.applicationReference = Object.freeze({ ...selection });
    this.selectedName = selection.name; this.expandedNames.add(selection.name);
    this.manual.add(selection.name); this.pending.add(selection.name);
    this.publish(); this.ports.changed(); this.ports.schedule();
  }
  get visibleNames(): readonly string[] {
    return [...new Set([...this.demands.values()].filter((demand) => !this.activeViewIds || this.activeViewIds.has(demand.viewId)).map((demand) => demand.name))];
  }
  completionNames = (): readonly string[] => this.names;
  get needsObservation() {
    const scope = this.ports.context();
    return !this.stopped && !!scope.project && !!scope.session && scope.connected && scope.runtimeState === "idle" &&
      ((this.listDirty && scope.capabilities.includes("workspace.snapshot")) ||
        (this.pending.size > 0 && scope.capabilities.includes("workspace.inspect_object")));
  }
  serialize() { return { expandedObjects: [...this.expandedNames], selectedObject: this.selectedName }; }
  restore(value: unknown) {
    this.reset();
    const data = value as { expandedObjects?: unknown; selectedObject?: unknown } | null;
    if (Array.isArray(data?.expandedObjects)) for (const name of data.expandedObjects) if (typeof name === "string") this.expandedNames.add(name);
    if (typeof data?.selectedObject === "string") this.selectedName = data.selectedObject;
    this.publish();
  }
  reset() {
    this.revision++; this.stopped = false; this.inFlight = null;
    this.dataValue = null; this.time = null; this.error = ""; this.staleValue = true;
    this.previews.clear(); this.pending.clear(); this.manual.clear(); this.demands.clear(); this.activeViewIds = null; this.listDirty = true; this.names = Object.freeze([]);
    this.expandedNames.clear(); this.selectedName = null; this.publish();
  }
  sessionChanged() {
    this.revision++; this.inFlight = null; this.dataValue = null; this.time = null;
    this.previews.clear(); this.manual.clear(); this.names = Object.freeze([]); this.error = ""; this.staleValue = true; this.listDirty = true;
    this.pending = new Set(this.visibleNames); this.publish(); this.ports.schedule();
  }
  stop() { this.stopped = true; this.revision++; this.inFlight = null; this.demands.clear(); this.pending.clear(); this.publish(); this.dispose(); }
  operationChanged(event: OperationChange) {
    const scope = this.ports.context();
    if (event.epoch === scope.epoch && event.project === scope.project && event.capability.startsWith("workspace.") && terminal(event.status)) this.invalidate();
  }
  invalidate() {
    this.invalidation++; this.listDirty = true; this.staleValue = true;
    for (const [name, observation] of this.previews) this.previews.set(name, Object.freeze({ ...observation, stale: true }));
    for (const name of this.visibleNames) this.pending.add(name);
    this.publish(); this.ports.schedule();
  }
  viewsChanged(event: DomainEvents["viewsChanged"]) {
    this.activeViewIds = new Set(event.activeViewIds);
    const visible = new Set(this.visibleNames);
    for (const name of this.pending) if (!visible.has(name) && !this.manual.has(name)) this.pending.delete(name);
    for (const name of visible) if (!this.previews.has(name) || this.previews.get(name)?.stale) this.pending.add(name);
    if (this.needsObservation) this.ports.schedule();
  }
  registerDemand(token: string, name: string, viewId: string): () => void {
    const demand = { name, viewId };
    this.demands.set(token, demand);
    if ((!this.activeViewIds || this.activeViewIds.has(viewId)) && (!this.previews.has(name) || this.previews.get(name)?.stale)) this.pending.add(name);
    if (this.needsObservation) this.ports.schedule();
    return () => { if (this.demands.get(token) === demand) this.releaseDemand(token); };
  }
  releaseDemand(token: string) {
    const name = this.demands.get(token)?.name; this.demands.delete(token);
    if (name && !this.visibleNames.includes(name) && !this.manual.has(name)) this.pending.delete(name);
  }
  toggleExpanded(name: string) { this.setExpanded(name, !this.expandedNames.has(name)); }
  setExpanded(name: string, expanded: boolean) {
    if (expanded) { this.expandedNames.add(name); this.selectedName = name; } else this.expandedNames.delete(name);
    this.publish(); this.ports.changed();
  }
  collapseAll() { this.expandedNames.clear(); this.publish(); this.ports.changed(); }
  inspect(name: string) { this.manual.add(name); this.pending.add(name); this.selectedName = name; this.publish(); this.ports.schedule(); }
  refresh() { this.invalidate(); }
  /** A scheduler slice makes exactly one serial Workspace query. */
  async observe() {
    const identity = { ...this.ports.context() };
    if (!this.needsObservation || this.inFlight || !identity.project || !identity.session) return;
    const listing = this.listDirty && identity.capabilities.includes("workspace.snapshot");
    const name = listing ? null : this.pending.values().next().value as string | undefined;
    if (!listing && !name) return;
    const capability = listing ? "workspace.snapshot" : "workspace.inspect_object";
    if (!identity.capabilities.includes(capability)) return;
    const flight = { revision: this.revision, generation: ++this.generation }, invalidation = this.invalidation;
    this.inFlight = flight; this.publish();
    const current = () => !this.stopped && this.inFlight === flight && flight.revision === this.revision && sameScope(identity, this.ports.context(), true);
    try {
      const result = await this.ports.query(identity.project, capability, listing ? { limit: 200, expected_session: identity.session } : { name, max_items: 20, expected_session: identity.session });
      if (!current()) return;
      if (result.target.identity !== identity.session) throw new Error("The object observation belongs to another R session.");
      if (result.status !== "ready" || !result.data) {
        this.error = result.notices.join("\n") || `Objects ${result.status}.`; this.staleValue = true; return;
      }
      if (listing) {
        const data = result.data as WorkspaceSnapshotData;
        if (!Array.isArray(data.objects)) throw new Error("The object observation is incomplete.");
        this.dataValue = immutable(data); this.time = result.observed_at_ms;
        const names = data.objects.map((object) => object.name);
        if (names.length !== this.names.length || names.some((name, index) => name !== this.names[index])) this.names = Object.freeze(names);
        this.listDirty = invalidation !== this.invalidation; this.staleValue = this.listDirty;
      } else if (name) {
        const binding = result.data as BindingSummary;
        if (binding.name !== name) throw new Error("The object preview identity does not match.");
        this.previews.set(name, immutable({ binding, observedAt: result.observed_at_ms, notice: result.notices.join("\n"), stale: invalidation !== this.invalidation }));
        if (invalidation === this.invalidation) { this.pending.delete(name); this.manual.delete(name); }
      }
      this.error = "";
    } catch (error) { if (current()) { this.error = message(error); this.staleValue = true; throw error; } }
    finally { if (current()) { this.inFlight = null; this.publish(); if (this.needsObservation) this.ports.schedule(); } }
  }
}
